// iOS may suspend the app between sending a Boat create and reading its reply, so the create's
// request ID and inputs (never the key) are saved first and replayed with the same ID. Stop,
// Resume and Delete are not replayed: someone may have changed the machine in the meantime.
import { boatRequestAnswered } from "@t3tools/client-runtime/boat";
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
import { Atom } from "effect/reactivity";
import * as SecureStore from "expo-secure-store";
import { msg } from "gt-react-native";

import { m } from "../../i18n/messages";
import { whenProtectedDataAvailable } from "../../lib/protectedData";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";

const storageKey = "t3code.boat-pending.v1";
/** An unanswered create older than this is dropped rather than started late. */
const PENDING_CREATE_TTL_MS = 60 * 60 * 1000;

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

type SavedCreate = Extract<BoatPendingRequest, { kind: "create" }> & { readonly savedAt: number };

let queue: Promise<unknown> = Promise.resolve();
/** One writer at a time, so two requests never overwrite each other's entry. */
function serialized<A>(task: () => Promise<A>): Promise<A> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

/** Null when the store could not be read, so callers leave it untouched. */
async function load(): Promise<ReadonlyArray<SavedCreate> | null> {
  try {
    await whenProtectedDataAvailable();
    const raw = await SecureStore.getItemAsync(storageKey);
    const value: unknown = raw === null ? [] : JSON.parse(raw);
    // Only dated creates replay; anything else (such as an older build's Delete) is dropped.
    return Array.isArray(value) ? value.filter(isSavedCreate) : [];
  } catch {
    return null;
  }
}

function isSavedCreate(value: unknown): value is SavedCreate {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "create" &&
    "savedAt" in value &&
    typeof value.savedAt === "number"
  );
}

const isFresh = (entry: SavedCreate, now: number) => now - entry.savedAt <= PENDING_CREATE_TTL_MS;

const update = (change: (saved: ReadonlyArray<SavedCreate>) => SavedCreate[]) =>
  serialized(async () => {
    const saved = await load();
    if (saved === null) return false;
    try {
      await SecureStore.setItemAsync(storageKey, JSON.stringify(change(saved)));
      return true;
    } catch {
      return false;
    }
  });

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

/** `answered` is false when the request may still have been accepted. */
type Outcome =
  | { readonly ok: true; readonly receipt: BoatOperationReceipt }
  | { readonly ok: false; readonly error: string | null; readonly answered: boolean };

async function send(request: BoatPendingRequest): Promise<Outcome> {
  const forget = () =>
    request.kind === "create"
      ? update((saved) =>
          saved.filter((entry) => entry.input.requestId !== request.input.requestId),
        )
      : Promise.resolve(true);
  const result = await commandFor(request);
  if (result._tag === "Success") {
    await forget();
    return { ok: true, receipt: result.value };
  }
  if (isAtomCommandInterrupted(result)) return { ok: false, error: null, answered: false };
  const error = squashAtomCommandFailure(result);
  const answered = boatRequestAnswered(error);
  if (answered) await forget();
  return { ok: false, error: String(error), answered };
}

/** Sends a request; a create is saved first and refused if it cannot be saved. */
export async function sendBoatRequest(request: BoatPendingRequest): Promise<Outcome> {
  if (request.kind === "create") {
    const savedAt = Date.now();
    const saved = await update((entries) => [
      ...entries.filter((entry) => entry.input.requestId !== request.input.requestId),
      { ...request, savedAt },
    ]);
    if (!saved) {
      return {
        ok: false,
        error: m(msg("Could not save the request on this device. Try again.")),
        answered: true,
      };
    }
  }
  return send(request);
}

/** Sends again every saved create for the controllers now connected, and drops stale ones. */
export async function resendPendingBoatRequests(connected: ReadonlySet<EnvironmentId>) {
  // Rewriting also drops what the loader refused, such as stale or undated entries.
  await update((entries) => entries.filter((entry) => isFresh(entry, Date.now())));
  const saved = await serialized(load);
  if (saved === null) return;
  for (const entry of saved) {
    // The clock is read at each send, so an entry that aged out during storage I/O stays out.
    if (!isFresh(entry, Date.now()) || !connected.has(entry.environmentId)) continue;
    const { savedAt: _savedAt, ...request } = entry;
    await send(request);
  }
}

const connectedBoatControllersAtom = Atom.make((get) =>
  [...get(environmentPresentations.presentationsAtom).entries()]
    .flatMap(([environmentId, presentation]) =>
      presentation.connection.phase === "connected" &&
      presentation.serverConfig?.boatEnvironments === true
        ? [environmentId]
        : [],
    )
    .join("\n"),
).pipe(Atom.withLabel("mobile:boat-connected-controllers"));

/** App-lifetime: whenever a Boat controller connects, finish creates left unanswered. */
export function installBoatRequestRecovery(): () => void {
  return appAtomRegistry.subscribe(
    connectedBoatControllersAtom,
    (key) => {
      if (key === "") return;
      void resendPendingBoatRequests(new Set(key.split("\n") as EnvironmentId[]));
    },
    { immediate: true },
  );
}
