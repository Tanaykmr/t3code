import * as Schema from "effect/Schema";
import {
  boatAllowedActions,
  BoatCreateInput,
  type BoatOperationReceipt,
  type BoatOperationKind,
  type BoatServer,
  type BoatSnapshot,
  EnvironmentId,
} from "@t3tools/contracts";

export type BoatAction = Exclude<BoatOperationKind, "create"> | "forget";

/** Only a small accent; rows stay neutral otherwise. */
export type BoatTone = "neutral" | "progress" | "success" | "warning" | "danger";

export interface BoatRow {
  /** Controller and managed ID: unique across controllers, stable before the guest exists. */
  readonly key: string;
  readonly controllerEnvironmentId: EnvironmentId;
  readonly server: BoatServer;
  readonly tone: BoatTone;
  readonly actions: ReadonlySet<BoatAction>;
  /** The row displays last known provider state. */
  readonly stale: boolean;
  readonly staleReason: "controller-offline" | "provider" | null;
  /** This device already has a saved connection to the guest. */
  readonly paired: boolean;
  readonly cost: BoatCost | null;
}

export interface BoatCost {
  readonly usd: number;
  /** "usage" is Boat's reported list price; "estimate" is wall time at the list rate. */
  readonly source: "usage" | "estimate";
  /** When Boat reported the usage; null for a live estimate. */
  readonly asOf: string | null;
}

export interface BoatControllerSnapshot {
  readonly environmentId: EnvironmentId;
  readonly snapshot: BoatSnapshot;
  readonly connected: boolean;
  readonly subscriptionStale?: boolean;
}

const TONES: Record<BoatServer["lifecycle"], BoatTone> = {
  provisioning: "progress",
  running: "success",
  stopping: "progress",
  stopped: "neutral",
  failed: "danger",
  deleting: "progress",
};

export function boatCost(
  server: BoatServer,
  rates: BoatSnapshot["rates"],
  nowMs: number,
  stale = false,
): BoatCost | null {
  const rate = rates.find((entry) => entry.size === server.size);
  if (server.usage !== null) {
    if (!stale && server.lifecycle === "running" && rate !== undefined) {
      const observedAt = Date.parse(server.usage.observedAt);
      const since =
        server.lastStartedAt === null
          ? observedAt
          : Math.max(observedAt, Date.parse(server.lastStartedAt));
      if (nowMs > since) {
        return {
          usd: server.usage.listPriceUsd + ((nowMs - since) / 3_600_000) * rate.usdPerHour,
          source: "estimate",
          asOf: null,
        };
      }
    }
    return { usd: server.usage.listPriceUsd, source: "usage", asOf: server.usage.observedAt };
  }
  if (stale && server.lifecycle === "running") return null;
  if (rate === undefined || server.lastStartedAt === null) return null;
  const end =
    server.lifecycle === "running"
      ? nowMs
      : Date.parse(server.lastStoppedAt ?? server.lastStartedAt);
  const hours = Math.max(0, end - Date.parse(server.lastStartedAt)) / 3_600_000;
  return { usd: hours * rate.usdPerHour, source: "estimate", asOf: null };
}

function actionsFor(server: BoatServer, snapshot: BoatSnapshot): ReadonlySet<BoatAction> {
  const actions = new Set<BoatAction>(boatAllowedActions(server));
  // A controller that cannot install T3 refuses Resume, so the button would only fail.
  if (snapshot.createAvailable === false) actions.delete("resume");
  if (
    snapshot.forgetAvailable === true &&
    (snapshot.account.status !== "configured" ||
      server.observedPower === "missing" ||
      server.lifecycle === "deleting" ||
      server.operation?.failure === "not-found" ||
      server.operation?.failure === "unresolved-create")
  ) {
    actions.add("forget");
  }
  return actions;
}

/**
 * Managed rows from every controller that advertises Boat, joined to the guests this device has
 * already paired so a paired guest is one row, not two.
 */
export function boatRows(input: {
  readonly controllers: ReadonlyArray<BoatControllerSnapshot>;
  readonly pairedEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly canManage: (controller: EnvironmentId) => boolean;
  readonly nowMs: number;
}): ReadonlyArray<BoatRow> {
  return input.controllers.flatMap(({ environmentId, snapshot, connected, subscriptionStale }) =>
    snapshot.servers.map((server) => {
      const staleReason = !connected
        ? "controller-offline"
        : subscriptionStale === true ||
            snapshot.providerStale === true ||
            snapshot.account.status !== "configured" ||
            server.observedPower === "missing"
          ? "provider"
          : null;
      return {
        key: `${environmentId}:${server.managedId}`,
        controllerEnvironmentId: environmentId,
        server,
        tone: TONES[server.lifecycle],
        actions:
          connected && input.canManage(environmentId) ? actionsFor(server, snapshot) : new Set(),
        stale: staleReason !== null,
        staleReason,
        paired:
          server.guestEnvironmentId !== null &&
          input.pairedEnvironmentIds.has(server.guestEnvironmentId),
        cost: boatCost(server, snapshot.rates, input.nowMs, staleReason !== null),
      };
    }),
  );
}

/**
 * Whether a Boat key may be sent over the active connection's socket: TLS or this machine (an
 * SSH tunnel's local forward counts). A plain-HTTP LAN route would carry the key in clear text.
 */
export function boatKeyRouteIsPrivate(socketUrl: string | null): boolean {
  if (socketUrl === null) return false;
  try {
    const url = new URL(socketUrl);
    if (url.protocol === "https:" || url.protocol === "wss:") return true;
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

const SavedBoatCreate = Schema.Struct({
  kind: Schema.Literal("create"),
  environmentId: EnvironmentId,
  input: BoatCreateInput,
  savedAt: Schema.Number,
});
export type SavedBoatCreate = typeof SavedBoatCreate.Type;
export type BoatCreateRequest = Omit<SavedBoatCreate, "savedAt">;

const decodeSavedBoatCreate = Schema.decodeUnknownSync(SavedBoatCreate);

export const decodeSavedBoatCreates = (value: unknown): ReadonlyArray<SavedBoatCreate> => {
  if (!Array.isArray(value)) throw new Error("Invalid Boat create journal");
  return value.flatMap((entry: unknown) =>
    typeof entry === "object" && entry !== null && "kind" in entry && entry.kind === "create"
      ? [decodeSavedBoatCreate({ savedAt: 0, ...entry })]
      : [],
  );
};

type BoatRequestOutcome =
  | { readonly ok: true; readonly receipt: BoatOperationReceipt }
  | { readonly ok: false; readonly error: string | null; readonly answered: boolean };

export function boatRequestAnswered(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    (error._tag === "EnvironmentAuthorizationError" ||
      (error._tag === "BoatError" && "code" in error && error.code !== "persistence"))
  );
}

/** Storage updates must serialize the read, comparison and write, including across browser tabs. */
export function createBoatCreateJournal(
  update: (
    change: (saved: ReadonlyArray<SavedBoatCreate>) => ReadonlyArray<SavedBoatCreate>,
  ) => Promise<ReadonlyArray<SavedBoatCreate>>,
  storageError: () => string,
  now: () => number,
) {
  let snapshot: {
    readonly entries: ReadonlyArray<SavedBoatCreate> | undefined;
    readonly busy: boolean;
  } = { entries: undefined, busy: false };
  const listeners = new Set<() => void>();
  let refreshRequested = false;
  let refreshVersion = 0;

  const publish = (next: typeof snapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  async function refresh() {
    if (snapshot.busy) {
      refreshRequested = true;
      return;
    }
    const previous = snapshot;
    const version = ++refreshVersion;
    try {
      const entries = await update((saved) => saved);
      if (snapshot === previous && version === refreshVersion) publish({ entries, busy: false });
    } catch {
      // Admission will check storage again before sending.
    }
  }

  const finish = () => {
    publish({ ...snapshot, busy: false });
    if (refreshRequested) {
      refreshRequested = false;
      void refresh();
    }
  };

  async function discard(entry: SavedBoatCreate) {
    if (snapshot.busy) return;
    publish({ ...snapshot, busy: true });
    try {
      const entries = await update((saved) => {
        const index = saved.findIndex(
          (candidate) =>
            candidate.environmentId === entry.environmentId &&
            candidate.input.requestId === entry.input.requestId &&
            candidate.savedAt === entry.savedAt,
        );
        return index === -1 ? saved : saved.filter((_, position) => position !== index);
      });
      publish({ entries, busy: true });
      return { ok: true as const };
    } catch {
      return { ok: false as const, error: storageError() };
    } finally {
      finish();
    }
  }

  async function submit(
    request: BoatCreateRequest,
    retry: boolean,
    send: (request: BoatCreateRequest) => Promise<BoatRequestOutcome>,
  ): Promise<BoatRequestOutcome | undefined> {
    if (snapshot.busy) return;
    publish({ ...snapshot, busy: true });
    let dispatched: SavedBoatCreate | undefined;
    try {
      const entries = await update((saved) => {
        if (retry) {
          dispatched = saved.find(
            (entry) =>
              entry.input.requestId === request.input.requestId &&
              entry.environmentId === request.environmentId,
          );
        } else if (saved.length === 0) {
          dispatched = { ...request, savedAt: now() };
          return [dispatched];
        }
        return saved;
      });
      publish({ entries, busy: true });
      if (dispatched === undefined) return;
      const { savedAt: _savedAt, ...original } = dispatched;
      const outcome = await send(original);
      if (outcome.ok || outcome.answered) {
        const remaining = await update((saved) =>
          saved.filter(
            (entry) =>
              entry.input.requestId !== original.input.requestId ||
              entry.environmentId !== original.environmentId,
          ),
        );
        publish({ entries: remaining, busy: true });
      }
      return outcome;
    } catch {
      return { ok: false, error: storageError(), answered: false };
    } finally {
      finish();
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      void refresh();
      return () => void listeners.delete(listener);
    },
    refresh,
    submit,
    discard,
  };
}

export const BOAT_TTL_CHOICES_SECONDS = [3600, 2 * 3600, 4 * 3600, 8 * 3600] as const;
