import {
  BoatSnapshot,
  BoatOperationReceipt,
  EnvironmentId,
  type BoatServer,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { boatCost, boatRows } from "./boat.ts";

// Wire JSON as a controller sends it; web and mobile both read rows through boatRows.
const CONTROLLER = EnvironmentId.make("env-controller");
const base = {
  displayName: "Scratch",
  size: "small",
  ttlSeconds: 3600,
  operation: null,
  sandboxId: "bx_22222222",
  guestEnvironmentId: "env-guest",
  origin: "https://bx_22222222.boat.dev",
  observedPower: "running",
  observedAt: "2026-11-23T10:00:00.000Z",
  autoStopAt: "2026-11-23T11:00:00.000Z",
  retention: "unknown",
  usage: null,
  createdAt: "2026-11-23T09:59:00.000Z",
  lastStartedAt: "2026-11-23T10:00:00.000Z",
  lastStoppedAt: null,
};
const wireSnapshot = {
  account: { status: "configured", label: "me@boat.dev" },
  rates: [{ size: "small", usdPerHour: 0.018, asOf: "2026-11-23" }],
  servers: [
    {
      ...base,
      managedId: "boat_provisioning",
      lifecycle: "provisioning",
      sandboxId: null,
      guestEnvironmentId: null,
      origin: null,
      observedPower: null,
      observedAt: null,
      autoStopAt: null,
      lastStartedAt: null,
      operation: {
        kind: "create",
        requestId: "00000000-0000-4000-8000-000000000001",
        stage: "allocating",
        failure: null,
        updatedAt: "2026-11-23T09:59:00.000Z",
      },
    },
    { ...base, managedId: "boat_running", lifecycle: "running" },
    {
      ...base,
      managedId: "boat_stopped",
      lifecycle: "stopped",
      observedPower: "stopped",
      retention: "available",
      autoStopAt: null,
      lastStoppedAt: "2026-11-23T10:30:00.000Z",
      usage: {
        machineSeconds: 900,
        listPriceUsd: 0.009,
        windowStart: "2026-11-23T10:00:00.000Z",
        windowEnd: "2026-11-23T10:30:00.000Z",
        observedAt: "2026-11-23T10:31:00.000Z",
      },
    },
    {
      ...base,
      managedId: "boat_failed",
      lifecycle: "failed",
      guestEnvironmentId: null,
      operation: {
        kind: "create",
        requestId: "00000000-0000-4000-8000-000000000002",
        stage: "failed",
        failure: "bootstrap-failed",
        updatedAt: "2026-11-23T10:01:00.000Z",
      },
    },
    // A row from a newer controller with a lifecycle this client does not know is dropped.
    { ...base, managedId: "boat_future", lifecycle: "hibernating" },
  ],
};

const snapshot = Schema.decodeUnknownSync(BoatSnapshot)(wireSnapshot);
const decodeReceipt = Schema.decodeUnknownSync(BoatOperationReceipt);
const nowMs = Date.parse("2026-11-23T10:30:00.000Z");
const rows = (connected: boolean, canManage = true) =>
  boatRows({
    controllers: [{ environmentId: CONTROLLER, snapshot, connected }],
    pairedEnvironmentIds: new Set([EnvironmentId.make("env-guest")]),
    canManage: () => canManage,
    nowMs,
  });
const byId = (list: ReturnType<typeof rows>, id: string) =>
  list.find((row) => row.server.managedId === id);

describe("boatRows", () => {
  it("keys rows by controller and managed ID, including a row before its guest exists", () => {
    const list = rows(true);
    expect(list.map((row) => row.key)).toEqual([
      "env-controller:boat_provisioning",
      "env-controller:boat_running",
      "env-controller:boat_stopped",
      "env-controller:boat_failed",
    ]);
    expect(byId(list, "boat_provisioning")).toMatchObject({ tone: "progress", paired: false });
  });

  it("offers each state's actions and joins rows to guests already paired", () => {
    const list = rows(true);
    expect([...(byId(list, "boat_provisioning")?.actions ?? [])]).toEqual(["stop"]);
    expect([...(byId(list, "boat_running")?.actions ?? [])]).toEqual(["stop"]);
    expect([...(byId(list, "boat_stopped")?.actions ?? [])].sort()).toEqual(["delete", "resume"]);
    expect([...(byId(list, "boat_failed")?.actions ?? [])].sort()).toEqual(["delete", "stop"]);
    expect(byId(list, "boat_running")?.paired).toBe(true);
    expect(byId(list, "boat_failed")?.paired).toBe(false);
  });

  it("keeps a disconnected controller's rows as stale, with no actions", () => {
    const list = rows(false);
    expect(list).toHaveLength(4);
    expect(list.every((row) => row.stale && row.actions.size === 0)).toBe(true);
  });

  it("offers no actions to a session without the management permission", () => {
    expect(rows(true, false).every((row) => row.actions.size === 0)).toBe(true);
  });

  it("disables Resume once the snapshot expired", () => {
    const expired = { ...byId(rows(true), "boat_stopped")!.server, retention: "expired" as const };
    const list = boatRows({
      controllers: [
        {
          environmentId: CONTROLLER,
          snapshot: { ...snapshot, servers: [expired] },
          connected: true,
        },
      ],
      pairedEnvironmentIds: new Set(),
      canManage: () => true,
      nowMs,
    });
    expect([...(list[0]?.actions ?? [])]).toEqual(["delete"]);
  });
});

describe("boatRows on a controller that cannot install T3", () => {
  it("offers no Resume", () => {
    const list = boatRows({
      controllers: [
        {
          environmentId: CONTROLLER,
          snapshot: { ...snapshot, createAvailable: false },
          connected: true,
        },
      ],
      pairedEnvironmentIds: new Set(),
      canManage: () => true,
      nowMs,
    });
    expect([...(byId(list, "boat_stopped")?.actions ?? [])]).toEqual(["delete"]);
  });
});

describe("boatCost", () => {
  it("prefers Boat's reported usage, else estimates wall time at the list rate", () => {
    const stopped = byId(rows(true), "boat_stopped")!.server;
    expect(boatCost(stopped, snapshot.rates, nowMs)).toEqual({
      usd: 0.009,
      source: "usage",
      asOf: "2026-11-23T10:31:00.000Z",
    });
    const running = byId(rows(true), "boat_running")!.server as BoatServer;
    const estimate = boatCost(running, snapshot.rates, nowMs);
    expect(estimate?.source).toBe("estimate");
    expect(estimate?.usd).toBeCloseTo(0.009, 6);
  });
});

describe("Boat wire compatibility", () => {
  it("round-trips a receipt", () => {
    const receipt = {
      managedId: "boat_x",
      requestId: "00000000-0000-4000-8000-000000000003",
      kind: "stop",
    };
    expect(decodeReceipt(receipt)).toEqual(receipt);
  });
});
