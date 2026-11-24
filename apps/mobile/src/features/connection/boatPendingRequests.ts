import {
  boatRequestAnswered,
  createBoatCreateJournal,
  decodeSavedBoatCreates,
  type BoatCreateRequest,
  type SavedBoatCreate,
} from "@t3tools/client-runtime/boat";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { BoatLifecycleInput, BoatOperationReceipt, EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import * as SecureStore from "expo-secure-store";
import { msg } from "gt-react-native";

import { m } from "../../i18n/messages";
import { whenProtectedDataAvailable } from "../../lib/protectedData";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";

const storageKey = "t3code.boat-pending.v1";
const AUTOMATIC_REPLAY_WINDOW_MS = 60 * 60 * 1000;

type BoatPendingRequest =
  | BoatCreateRequest
  | {
      readonly kind: "stop" | "resume" | "delete";
      readonly environmentId: EnvironmentId;
      readonly input: BoatLifecycleInput;
    };

export function selectBoatCreateController<
  Controller extends {
    readonly environment: { readonly environmentId: EnvironmentId };
  },
>(
  eligible: ReadonlyArray<Controller>,
  selectedId: EnvironmentId | null,
  pending: { readonly environmentId: EnvironmentId } | null,
): Controller | undefined {
  const targetId = pending?.environmentId ?? selectedId;
  const selected = eligible.find((entry) => entry.environment.environmentId === targetId);
  return pending === null ? (selected ?? eligible[0]) : selected;
}

let queue: Promise<unknown> = Promise.resolve();
/** One writer at a time, so two requests never overwrite each other's entry. */
function serialized<A>(task: () => Promise<A>): Promise<A> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

export const boatCreateJournal = createBoatCreateJournal(
  (change) =>
    serialized(async () => {
      await whenProtectedDataAvailable();
      const raw = await SecureStore.getItemAsync(storageKey);
      const saved = raw === null ? [] : decodeSavedBoatCreates(JSON.parse(raw));
      const next: ReadonlyArray<SavedBoatCreate> = change(saved);
      if (next !== saved) await SecureStore.setItemAsync(storageKey, JSON.stringify(next));
      return next;
    }),
  () => m(msg("Could not save the request on this device. Try again.")),
  () => Date.now(),
);

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
  const result = await commandFor(request);
  if (result._tag === "Success") return { ok: true, receipt: result.value };
  if (isAtomCommandInterrupted(result)) return { ok: false, error: null, answered: false };
  const error = squashAtomCommandFailure(result);
  return { ok: false, error: String(error), answered: boatRequestAnswered(error) };
}

export function sendBoatRequest(
  request: Exclude<BoatPendingRequest, BoatCreateRequest>,
): Promise<Outcome>;
export function sendBoatRequest(
  request: BoatCreateRequest,
  retry?: boolean,
): Promise<Outcome | undefined>;
export function sendBoatRequest(request: BoatPendingRequest, retry = false) {
  return request.kind === "create" ? boatCreateJournal.submit(request, retry, send) : send(request);
}

/** Automatic recovery has a deadline. Older intents remain locked to an explicit retry. */
export async function resendPendingBoatRequests(connected: ReadonlySet<EnvironmentId>) {
  await boatCreateJournal.refresh();
  for (const entry of boatCreateJournal.getSnapshot().entries ?? []) {
    if (
      Date.now() - entry.savedAt <= AUTOMATIC_REPLAY_WINDOW_MS &&
      connected.has(entry.environmentId)
    ) {
      await sendBoatRequest(entry, true);
    }
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
