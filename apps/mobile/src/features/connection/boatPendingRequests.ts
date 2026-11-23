// iOS may suspend or kill the app between sending a Boat request and reading its reply. The
// request ID and inputs (never the key) are saved first, so the same request can be sent again
// and the controller answers with the operation it already started.
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  BoatCreateInput,
  BoatLifecycleInput,
  BoatOperationReceipt,
  EnvironmentId,
} from "@t3tools/contracts";
import * as SecureStore from "expo-secure-store";

import { whenProtectedDataAvailable } from "../../lib/protectedData";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";

const storageKey = "t3code.boat-pending.v1";

export type BoatPendingRequest =
  | {
      readonly kind: "create";
      readonly environmentId: EnvironmentId;
      readonly input: BoatCreateInput;
    }
  | {
      readonly kind: "stop" | "resume" | "delete";
      readonly environmentId: EnvironmentId;
      readonly input: BoatLifecycleInput;
    };

let queue: Promise<unknown> = Promise.resolve();
/** One writer at a time, so two requests never overwrite each other's entry. */
function serialized<A>(task: () => Promise<A>): Promise<A> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

async function load(): Promise<ReadonlyArray<BoatPendingRequest>> {
  try {
    await whenProtectedDataAvailable();
    const raw = await SecureStore.getItemAsync(storageKey);
    const value: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(value) ? (value as ReadonlyArray<BoatPendingRequest>) : [];
  } catch {
    return [];
  }
}

async function save(requests: ReadonlyArray<BoatPendingRequest>) {
  try {
    await SecureStore.setItemAsync(storageKey, JSON.stringify(requests));
  } catch {
    // Recovery is best effort; the request itself still goes out.
  }
}

const update = (change: (requests: ReadonlyArray<BoatPendingRequest>) => BoatPendingRequest[]) =>
  serialized(async () => save(change(await load())));

function commandFor(request: BoatPendingRequest) {
  switch (request.kind) {
    case "create":
      return runAtomCommand(appAtomRegistry, serverEnvironment.createBoat, request, {
        reportFailure: false,
      });
    case "stop":
      return runAtomCommand(appAtomRegistry, serverEnvironment.stopBoat, request, {
        reportFailure: false,
      });
    case "resume":
      return runAtomCommand(appAtomRegistry, serverEnvironment.resumeBoat, request, {
        reportFailure: false,
      });
    case "delete":
      return runAtomCommand(appAtomRegistry, serverEnvironment.deleteBoat, request, {
        reportFailure: false,
      });
  }
}

/** A typed answer from the controller settles the request; a lost connection does not. */
function settled(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    (error._tag === "BoatError" || error._tag === "EnvironmentAuthorizationError")
  );
}

/** Saves the request, sends it, and forgets it once the controller has answered. */
export async function sendBoatRequest(
  request: BoatPendingRequest,
): Promise<
  | { readonly ok: true; readonly receipt: BoatOperationReceipt }
  | { readonly ok: false; readonly error: string | null }
> {
  const sameRequest = (entry: BoatPendingRequest) =>
    entry.input.requestId === request.input.requestId;
  await update((requests) => [...requests.filter((entry) => !sameRequest(entry)), request]);
  const result = await commandFor(request);
  if (result._tag === "Success") {
    await update((requests) => requests.filter((entry) => !sameRequest(entry)));
    return { ok: true, receipt: result.value };
  }
  if (isAtomCommandInterrupted(result)) return { ok: false, error: null };
  const error = squashAtomCommandFailure(result);
  if (settled(error)) await update((requests) => requests.filter((entry) => !sameRequest(entry)));
  return { ok: false, error: String(error) };
}

/** Sends again every saved request for the controllers now connected. */
export async function resendPendingBoatRequests(connected: ReadonlySet<EnvironmentId>) {
  const pending = (await serialized(load)).filter((entry) => connected.has(entry.environmentId));
  for (const request of pending) await sendBoatRequest(request);
}
