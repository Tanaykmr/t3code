import {
  boatAllowedActions,
  type BoatOperationKind,
  type BoatServer,
  type BoatSnapshot,
  type EnvironmentId,
} from "@t3tools/contracts";

export type BoatAction = Exclude<BoatOperationKind, "create">;

/** Only a small accent; rows stay neutral otherwise. */
export type BoatTone = "neutral" | "progress" | "success" | "warning" | "danger";

export interface BoatRow {
  /** Controller and managed ID: unique across controllers, stable before the guest exists. */
  readonly key: string;
  readonly controllerEnvironmentId: EnvironmentId;
  readonly server: BoatServer;
  readonly tone: BoatTone;
  readonly actions: ReadonlySet<BoatAction>;
  /** The controller is not connected; the row is its last snapshot. */
  readonly stale: boolean;
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
): BoatCost | null {
  if (server.usage !== null) {
    return { usd: server.usage.listPriceUsd, source: "usage", asOf: server.usage.observedAt };
  }
  const rate = rates.find((entry) => entry.size === server.size);
  if (rate === undefined || server.lastStartedAt === null) return null;
  const end =
    server.lifecycle === "running"
      ? nowMs
      : Date.parse(server.lastStoppedAt ?? server.lastStartedAt);
  const hours = Math.max(0, end - Date.parse(server.lastStartedAt)) / 3_600_000;
  return { usd: hours * rate.usdPerHour, source: "estimate", asOf: null };
}

function actionsFor(server: BoatServer, snapshot: BoatSnapshot): ReadonlySet<BoatAction> {
  const actions = new Set(boatAllowedActions(server));
  // A controller that cannot install T3 refuses Resume, so the button would only fail.
  if (snapshot.createAvailable === false) actions.delete("resume");
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
  return input.controllers.flatMap(({ environmentId, snapshot, connected }) =>
    snapshot.servers.map((server) => ({
      key: `${environmentId}:${server.managedId}`,
      controllerEnvironmentId: environmentId,
      server,
      tone: TONES[server.lifecycle],
      actions:
        connected && input.canManage(environmentId) ? actionsFor(server, snapshot) : new Set(),
      stale: !connected,
      paired:
        server.guestEnvironmentId !== null &&
        input.pairedEnvironmentIds.has(server.guestEnvironmentId),
      cost: boatCost(server, snapshot.rates, input.nowMs),
    })),
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

export const BOAT_TTL_CHOICES_SECONDS = [3600, 2 * 3600, 4 * 3600, 8 * 3600] as const;
