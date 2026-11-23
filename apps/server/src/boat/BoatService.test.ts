import { describe, expect, it } from "@effect/vitest";
import { BoatRequestId, type BoatSnapshot, EnvironmentId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { BoatApiError } from "./BoatApi.ts";
import { FAKE_BOAT_KEY, type FakeBoatOptions, makeFakeBoat } from "./BoatApiFake.ts";
import * as BoatService from "./BoatService.ts";

let requestCounter = 0;
const requestId = () =>
  BoatRequestId.make(`00000000-0000-4000-8000-${String(++requestCounter).padStart(12, "0")}`);

function setup(options: FakeBoatOptions = {}) {
  const fake = makeFakeBoat(options);
  const secrets = new Map<string, Uint8Array>();
  const layer = Layer.effect(BoatService.BoatService, BoatService.make).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        fake.layer,
        SqlitePersistence.layerMemory,
        Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: (name) => Effect.sync(() => Option.fromNullishOr(secrets.get(name))),
          set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
          remove: (name) => Effect.sync(() => void secrets.delete(name)),
        }),
        Layer.mock(ServerEnvironment)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("env-controller")),
        }),
      ),
    ),
  );
  return { fake, secrets, layer };
}

const snapshot = BoatService.BoatService.use((boat) =>
  boat.snapshots.pipe(Stream.take(1), Stream.runHead, Effect.map(Option.getOrThrow)),
);
const server = (managedId: string) =>
  snapshot.pipe(
    Effect.map((value: BoatSnapshot) => value.servers.find((row) => row.managedId === managedId)),
  );
const configure = BoatService.BoatService.use((boat) => boat.setApiKey({ apiKey: FAKE_BOAT_KEY }));
const settle = BoatService.BoatService.use((boat) => boat.reconcile);

const createSmall = BoatService.BoatService.use((boat) =>
  boat.create({ requestId: requestId(), displayName: "Scratch", size: "small", ttlSeconds: 3600 }),
);

describe("BoatService", () => {
  it.effect("stores only a key Boat accepts and shows its account, never the key", () => {
    const { layer, secrets } = setup();
    return Effect.gen(function* () {
      const boat = yield* BoatService.BoatService;
      expect(yield* boat.setApiKey({ apiKey: "boat_wrong" })).toEqual({ status: "invalid" });
      expect(secrets.size).toBe(0);
      expect((yield* snapshot).account).toEqual({ status: "missing", label: null });

      expect(yield* configure).toEqual({ status: "configured" });
      const shown = yield* snapshot;
      expect(shown.account).toEqual({ status: "configured", label: "fake@boat.dev" });
      expect(JSON.stringify(shown)).not.toContain(FAKE_BOAT_KEY);

      expect(yield* boat.setApiKey({ apiKey: null })).toEqual({ status: "missing" });
      expect(secrets.size).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses to create without a configured key", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const error = yield* Effect.flip(createSmall);
      expect(error.code).toBe("not-configured");
    }).pipe(Effect.provide(layer));
  });

  it.effect("creates one machine per request ID and reaches Running with a verified guest", () => {
    const { layer, fake } = setup();
    return Effect.gen(function* () {
      const boat = yield* BoatService.BoatService;
      yield* configure;
      const input = {
        requestId: requestId(),
        displayName: "Scratch",
        size: "small" as const,
        ttlSeconds: 3600,
      };
      const receipt = yield* boat.create(input);
      expect(yield* boat.create(input)).toEqual(receipt);
      expect((yield* Effect.flip(boat.create({ ...input, size: "default" }))).code).toBe(
        "conflict",
      );
      yield* settle;

      const row = yield* server(receipt.managedId);
      expect(row).toMatchObject({
        lifecycle: "running",
        guestEnvironmentId: "env-guest-1",
        origin: "https://bx_22222221.fake.boat.dev",
        observedPower: "running",
        operation: { kind: "create", stage: "completed", failure: null },
      });
      expect(row?.autoStopAt).not.toBeNull();
      expect(row?.usage).not.toBeNull();
      expect(fake.sandboxes.size).toBe(1);
      expect([...fake.sandboxes.values()][0]?.sandbox.labels).toEqual({
        "t3.role": "environment",
        "t3.controller": "env-controller",
        "t3.managed": receipt.managedId,
      });
    }).pipe(Effect.provide(layer));
  });

  // Live clock: the retry waits out its one-second backoff for real.
  it.live("retries a create whose reply was lost with the same key and gets one machine", () => {
    const { layer, fake } = setup();
    return Effect.gen(function* () {
      yield* configure;
      fake.loseNextResponse("create");
      const receipt = yield* createSmall;
      yield* settle;
      expect(fake.calls.filter((name) => name === "create")).toHaveLength(2);
      expect(fake.sandboxes.size).toBe(1);
      expect((yield* server(receipt.managedId))?.lifecycle).toBe("running");
    }).pipe(Effect.provide(layer));
  });

  it.effect("stops a machine stopped during provisioning before exposing its guest", () => {
    const gate = Deferred.makeUnsafe<void>();
    let hold = false;
    const { layer, fake } = setup({
      latency: Effect.suspend(() => (hold ? Deferred.await(gate) : Effect.void)),
    });
    return Effect.gen(function* () {
      const boat = yield* BoatService.BoatService;
      yield* configure;
      hold = true;
      const { managedId } = yield* createSmall;
      yield* boat.stop({ requestId: requestId(), managedId });
      expect((yield* server(managedId))?.lifecycle).toBe("stopping");
      yield* Deferred.succeed(gate, undefined);
      yield* settle;
      const row = yield* server(managedId);
      expect(row?.lifecycle).toBe("stopped");
      expect(row?.guestEnvironmentId).toBeNull();
      expect(fake.calls).not.toContain("bootstrap");
      expect([...fake.sandboxes.values()][0]?.sandbox.state).toBe("archived");
    }).pipe(Effect.provide(layer));
  });

  it.effect("stops, resumes the same guest, and deletes only a stopped machine", () => {
    const { layer, fake } = setup();
    return Effect.gen(function* () {
      const boat = yield* BoatService.BoatService;
      yield* configure;
      const { managedId } = yield* createSmall;
      yield* settle;
      const sandboxId = (yield* server(managedId))?.sandboxId;

      expect((yield* Effect.flip(boat.delete({ requestId: requestId(), managedId }))).code).toBe(
        "invalid-state",
      );

      const stop = { requestId: requestId(), managedId };
      yield* boat.stop(stop);
      // A lost reply is resolved by sending the same request again.
      expect(yield* boat.stop(stop)).toEqual({ ...stop, kind: "stop" });
      yield* settle;
      expect(yield* server(managedId)).toMatchObject({
        lifecycle: "stopped",
        observedPower: "stopped",
        retention: "available",
        autoStopAt: null,
      });

      yield* boat.resume({ requestId: requestId(), managedId });
      yield* settle;
      expect(yield* server(managedId)).toMatchObject({
        lifecycle: "running",
        sandboxId,
        guestEnvironmentId: "env-guest-1",
      });

      yield* boat.stop({ requestId: requestId(), managedId });
      yield* settle;
      yield* boat.delete({ requestId: requestId(), managedId });
      yield* settle;
      expect(yield* server(managedId)).toBeUndefined();
      expect(fake.sandboxes.size).toBe(0);
      const sql = yield* SqlClient.SqlClient;
      const tombstone = yield* sql<{ readonly deleted_at: string | null }>`
        SELECT deleted_at FROM boat_servers WHERE managed_id = ${managedId}
      `;
      expect(tombstone[0]?.deleted_at).not.toBeNull();
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails a resume that finds another identity and asks Boat to stop it", () => {
    const { layer, fake } = setup();
    return Effect.gen(function* () {
      const boat = yield* BoatService.BoatService;
      yield* configure;
      const { managedId } = yield* createSmall;
      yield* settle;
      yield* boat.stop({ requestId: requestId(), managedId });
      yield* settle;
      const sandboxId = (yield* server(managedId))?.sandboxId ?? "";
      fake.replaceGuestIdentity(sandboxId);

      yield* boat.resume({ requestId: requestId(), managedId });
      yield* settle;
      const row = yield* server(managedId);
      expect(row?.lifecycle).toBe("failed");
      expect(row?.operation).toMatchObject({ kind: "resume", failure: "bootstrap-failed" });
      expect(row?.guestEnvironmentId).toBe("env-guest-1");
      expect(fake.sandboxes.get(sandboxId)?.sandbox.state).toBe("archived");
    }).pipe(Effect.provide(layer));
  });

  it.effect("shows Boat's own TTL archive and an external deletion on reconcile", () => {
    const { layer, fake } = setup();
    return Effect.gen(function* () {
      const boat = yield* BoatService.BoatService;
      yield* configure;
      const { managedId } = yield* createSmall;
      yield* settle;
      const sandboxId = (yield* server(managedId))?.sandboxId ?? "";

      fake.archiveExternally(sandboxId, 0);
      yield* settle;
      expect((yield* server(managedId))?.lifecycle).toBe("stopped");

      fake.deleteExternally(sandboxId);
      yield* settle;
      expect(yield* server(managedId)).toMatchObject({
        lifecycle: "stopped",
        observedPower: "missing",
        retention: "expired",
      });
      expect((yield* Effect.flip(boat.resume({ requestId: requestId(), managedId }))).code).toBe(
        "invalid-state",
      );
      // Deleting what is already gone completes as absence.
      yield* boat.delete({ requestId: requestId(), managedId });
      yield* settle;
      expect(yield* server(managedId)).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect("past Boat's idempotency window, adopts one labeled match and never creates", () => {
    const { layer, fake } = setup();
    return Effect.gen(function* () {
      yield* configure;
      const { managedId } = yield* createSmall;
      yield* settle;
      const sandboxId = (yield* server(managedId))?.sandboxId;

      // As if the create reply was lost and the controller stayed down for a day.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE boat_operations SET stage = 'queued'`;
      yield* sql`UPDATE boat_servers SET lifecycle = 'provisioning', sandbox_id = NULL`;
      yield* TestClock.adjust("25 hours");
      yield* settle;
      expect(yield* server(managedId)).toMatchObject({ lifecycle: "running", sandboxId });
      expect(fake.calls.filter((name) => name === "create")).toHaveLength(1);
      expect(fake.calls).toContain("list");
    }).pipe(Effect.provide(layer));
  });

  it.effect("past the window with no labeled match, leaves the create unresolved", () => {
    const { layer, fake } = setup();
    return Effect.gen(function* () {
      yield* configure;
      fake.failNext("create", new BoatApiError({ category: "rejected" }));
      const { managedId } = yield* createSmall;
      yield* settle;
      expect((yield* server(managedId))?.operation?.failure).toBe("provider-rejected");

      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE boat_operations SET stage = 'queued', failure = NULL`;
      yield* TestClock.adjust("25 hours");
      yield* settle;
      expect((yield* server(managedId))?.operation?.failure).toBe("unresolved-create");
      expect(fake.sandboxes.size).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps the key while it still manages machines", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const boat = yield* BoatService.BoatService;
      yield* configure;
      yield* createSmall;
      const error = yield* Effect.flip(boat.setApiKey({ apiKey: null }));
      expect(error.code).toBe("invalid-state");
    }).pipe(Effect.provide(layer));
  });
});
