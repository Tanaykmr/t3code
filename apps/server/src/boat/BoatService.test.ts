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

  it.effect("refuses Create and Resume while this server cannot install T3 on a machine", () => {
    const { layer, fake } = setup({ bootstrapAvailable: false });
    return Effect.gen(function* () {
      yield* configure;
      expect((yield* Effect.flip(createSmall)).code).toBe("invalid-state");
      expect((yield* snapshot).createAvailable).toBe(false);
      expect(fake.sandboxes.size).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses to purge a machine Boat reports running, and shows it running", () => {
    const { layer, fake } = setup();
    return Effect.gen(function* () {
      const boat = yield* BoatService.BoatService;
      yield* configure;
      const { managedId } = yield* createSmall;
      yield* settle;
      yield* boat.stop({ requestId: requestId(), managedId });
      yield* settle;
      const sandboxId = (yield* server(managedId))?.sandboxId ?? "";
      fake.resumeExternally(sandboxId);

      yield* boat.delete({ requestId: requestId(), managedId });
      yield* settle;
      expect(yield* server(managedId)).toMatchObject({
        lifecycle: "running",
        observedPower: "running",
        operation: { kind: "delete", failure: "machine-running" },
      });
      expect(fake.calls).not.toContain("delete");
      expect(fake.sandboxes.has(sandboxId)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("after a restart, does not stop again a machine that already archived", () => {
    const { layer, fake } = setup();
    return Effect.gen(function* () {
      const boat = yield* BoatService.BoatService;
      yield* configure;
      const { managedId } = yield* createSmall;
      yield* settle;
      yield* boat.stop({ requestId: requestId(), managedId });
      yield* settle;
      // As if the controller restarted before recording that the stop finished.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE boat_operations SET stage = 'stopping' WHERE kind = 'stop'`;
      yield* settle;
      expect(fake.calls.filter((name) => name === "stop")).toHaveLength(1);
      expect((yield* server(managedId))?.lifecycle).toBe("stopped");
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "does not allocate a create queued before the server lost the ability to set up",
    () => {
      const { layer, fake } = setup({ bootstrapAvailable: false });
      return Effect.gen(function* () {
        yield* configure;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
        INSERT INTO boat_servers (managed_id, account_id, display_name, size, ttl_seconds, lifecycle, retention, created_at)
        VALUES ('boat_queued', 'acct_fake', 'Queued', 'small', 3600, 'provisioning', 'unknown', '1970-01-01T00:00:00.000Z')
      `;
        yield* sql`
        INSERT INTO boat_operations (request_id, managed_id, kind, payload_json, stage, created_at, updated_at)
        VALUES ('00000000-0000-4000-8000-0000000000ff', 'boat_queued', 'create', '', 'queued', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')
      `;
        yield* settle;
        expect((yield* server("boat_queued"))?.operation?.failure).toBe("bootstrap-unavailable");
        expect(fake.calls).not.toContain("create");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("keeps stopping a machine a failed create left running", () => {
    const { layer, fake } = setup();
    return Effect.gen(function* () {
      yield* configure;
      fake.failNext("bootstrap", new BoatApiError({ category: "rejected" }));
      fake.failNext("stop", new BoatApiError({ category: "rejected" }));
      const { managedId } = yield* createSmall;
      yield* settle;
      const sandboxId = (yield* server(managedId))?.sandboxId ?? "";
      // The cleanup stop failed once; the reconcile pass sent it again.
      expect(fake.calls.filter((name) => name === "stop")).toHaveLength(2);
      expect(fake.sandboxes.get(sandboxId)?.sandbox.state).toBe("archived");
      expect((yield* server(managedId))?.lifecycle).toBe("failed");
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a queued resume it cannot finish without stopping the machine", () => {
    const { layer, fake } = setup();
    return Effect.gen(function* () {
      const boat = yield* BoatService.BoatService;
      yield* configure;
      const { managedId } = yield* createSmall;
      yield* settle;
      yield* boat.stop({ requestId: requestId(), managedId });
      yield* settle;
      const sandboxId = (yield* server(managedId))?.sandboxId ?? "";
      // Accepted by the old build, then the controller restarts on one that cannot install T3,
      // while someone resumes the machine from Boat's dashboard.
      const sql = yield* SqlClient.SqlClient;
      const resumeId = requestId();
      yield* sql`
        INSERT INTO boat_operations (request_id, managed_id, kind, payload_json, stage, created_at, updated_at)
        VALUES (${resumeId}, ${managedId}, 'resume', ${managedId}, 'queued', '1970-01-01T00:00:01.000Z', '1970-01-01T00:00:01.000Z')
      `;
      fake.setBootstrapAvailable(false);
      fake.resumeExternally(sandboxId);
      const stopsBefore = fake.calls.filter((name) => name === "stop").length;
      yield* settle;
      expect((yield* server(managedId))?.operation).toMatchObject({
        kind: "resume",
        failure: "bootstrap-unavailable",
      });
      expect(fake.calls.filter((name) => name === "stop")).toHaveLength(stopsBefore);
      expect(fake.calls).not.toContain("resume");
      expect(fake.sandboxes.get(sandboxId)?.sandbox.state).toBe("running");
    }).pipe(Effect.provide(layer));
  });

  it.effect("settles a resume Boat refuses while the machine stays archived", () => {
    const { layer, fake } = setup();
    return Effect.gen(function* () {
      const boat = yield* BoatService.BoatService;
      yield* configure;
      const { managedId } = yield* createSmall;
      yield* settle;
      yield* boat.stop({ requestId: requestId(), managedId });
      yield* settle;
      fake.failNext("resume", new BoatApiError({ category: "conflict", code: "busy" }));
      yield* boat.resume({ requestId: requestId(), managedId });
      yield* settle;
      expect((yield* server(managedId))?.operation).toMatchObject({
        kind: "resume",
        failure: "provider-rejected",
      });
      // The queue is clear, so the next request runs.
      yield* boat.delete({ requestId: requestId(), managedId });
      yield* settle;
      expect(yield* server(managedId)).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps looking for a create that may have reached Boat instead of dropping it", () => {
    const { layer, fake } = setup({ bootstrapAvailable: false });
    return Effect.gen(function* () {
      yield* configure;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO boat_servers (managed_id, account_id, display_name, size, ttl_seconds, lifecycle, retention, created_at)
        VALUES ('boat_sent', 'acct_fake', 'Sent', 'small', 3600, 'provisioning', 'unknown', '1970-01-01T00:00:00.000Z')
      `;
      // It left "queued", so an earlier build may have sent it before restarting.
      yield* sql`
        INSERT INTO boat_operations (request_id, managed_id, kind, payload_json, stage, created_at, updated_at)
        VALUES ('00000000-0000-4000-8000-0000000000fe', 'boat_sent', 'create', '', 'allocating', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')
      `;
      yield* settle;
      expect((yield* server("boat_sent"))?.operation).toMatchObject({
        stage: "allocating",
        failure: null,
      });
      expect(fake.calls).toContain("list");
      expect(fake.calls).not.toContain("create");
    }).pipe(Effect.provide(layer));
  });

  it.effect("lets a stop queued behind a resume win without waking the machine", () => {
    const gate = Deferred.makeUnsafe<void>();
    let hold = false;
    const { layer, fake } = setup({
      latency: Effect.suspend(() => (hold ? Deferred.await(gate) : Effect.void)),
    });
    return Effect.gen(function* () {
      const boat = yield* BoatService.BoatService;
      yield* configure;
      const { managedId } = yield* createSmall;
      yield* settle;
      yield* boat.stop({ requestId: requestId(), managedId });
      yield* settle;
      hold = true;
      // The resume's worker is parked on the account read; the stop queues behind it.
      const sql = yield* SqlClient.SqlClient;
      const resumeId = requestId();
      yield* sql`
        INSERT INTO boat_operations (request_id, managed_id, kind, payload_json, stage, created_at, updated_at)
        VALUES (${resumeId}, ${managedId}, 'resume', ${managedId}, 'queued', '1970-01-01T00:00:01.000Z', '1970-01-01T00:00:01.000Z')
      `;
      yield* sql`
        INSERT INTO boat_operations (request_id, managed_id, kind, payload_json, stage, created_at, updated_at)
        VALUES (${requestId()}, ${managedId}, 'stop', ${managedId}, 'queued', '1970-01-01T00:00:02.000Z', '1970-01-01T00:00:02.000Z')
      `;
      hold = false;
      yield* Deferred.succeed(gate, undefined);
      yield* settle;
      expect(fake.calls).not.toContain("resume");
      expect((yield* server(managedId))?.lifecycle).toBe("stopped");
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
