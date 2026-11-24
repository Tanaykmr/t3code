// An in-memory Boat for tests and the source-build `T3CODE_DEV_BOAT_FAKE=1` switch. It keeps the
// documented semantics the lifecycle depends on: create idempotency, coalesced stop, label
// filtering, deletion operations, and 404 after purge.
import { EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import {
  BoatApi,
  BoatApiError,
  BoatBootstrapError,
  type BoatCreateRequest,
  BoatGuestBootstrap,
  type BoatKey,
  type BoatSandbox,
} from "./BoatApi.ts";

export const FAKE_BOAT_KEY = "boat_fake_valid_key";

interface FakeSandbox {
  sandbox: BoatSandbox;
  readonly requestBody: string;
  readonly guestId: EnvironmentId;
  startedAt: number;
}

export interface FakeBoatOptions {
  /** Applied to every call so a dev UI can show each stage. */
  readonly latency?: Effect.Effect<void>;
  /** False stands in for a release build, which cannot install T3 on a machine yet. */
  readonly bootstrapAvailable?: boolean;
}

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
const RETENTION_MS = 14 * 24 * 3600 * 1000;

export function makeFakeBoat(options: FakeBoatOptions = {}) {
  const latency = options.latency ?? Effect.void;
  const sandboxes = new Map<string, FakeSandbox>();
  const idempotency = new Map<string, string>();
  const deletions = new Set<string>();
  const calls: Array<string> = [];
  const failures = new Map<string, BoatApiError>();
  const lostResponses = new Set<string>();
  let nextId = 0;

  /** Records the call, applies a queued failure, and checks the key. Returns now in millis. */
  const enter = Effect.fn("FakeBoat.enter")(function* (name: string, key: BoatKey) {
    yield* latency;
    calls.push(name);
    const failure = failures.get(name);
    if (failure !== undefined) {
      failures.delete(name);
      return yield* failure;
    }
    if (Redacted.value(key) !== FAKE_BOAT_KEY) {
      return yield* new BoatApiError({ category: "unauthorized" });
    }
    return DateTime.toEpochMillis(yield* DateTime.now);
  });

  const find = Effect.fn("FakeBoat.find")(function* (sandboxId: string) {
    const entry = sandboxes.get(sandboxId);
    if (entry === undefined) {
      return yield* new BoatApiError({ category: "not-found", code: "not_found" });
    }
    return entry;
  });

  const patch = (entry: FakeSandbox, next: Partial<BoatSandbox>) => {
    entry.sandbox = { ...entry.sandbox, ...next };
  };
  const archive = (entry: FakeSandbox, now: number) =>
    patch(entry, {
      state: "archived",
      stoppedAt: iso(now),
      archiveAfter: null,
      snapshotAvailable: true,
      dataExpiredAt: iso(now + RETENTION_MS),
      stopStatus: "completed",
    });

  const createSandbox = Effect.fn("FakeBoat.create")(function* (
    key: BoatKey,
    request: BoatCreateRequest,
  ) {
    const now = yield* enter("create", key);
    const body = [request.name, request.size, request.ttlSeconds].join("\u0000");
    const existing = idempotency.get(request.idempotencyKey);
    if (existing !== undefined) {
      const entry = yield* find(existing);
      if (entry.requestBody !== body) {
        return yield* new BoatApiError({ category: "conflict", code: "idempotency_key_reused" });
      }
      return entry.sandbox;
    }
    nextId += 1;
    const id = `bx_${String(nextId).padStart(8, "2")}`;
    const entry: FakeSandbox = {
      requestBody: body,
      guestId: EnvironmentId.make(`env-guest-${nextId}`),
      startedAt: now,
      sandbox: {
        id,
        state: "ready",
        labels: { ...request.labels },
        archiveAfter: iso(now + request.ttlSeconds * 1000),
        stoppedAt: null,
        dataExpiredAt: null,
        snapshotAvailable: false,
        stopStatus: null,
      },
    };
    sandboxes.set(id, entry);
    idempotency.set(request.idempotencyKey, id);
    return entry.sandbox;
  });

  const stopSandbox = Effect.fn("FakeBoat.stop")(function* (key: BoatKey, sandboxId: string) {
    const now = yield* enter("stop", key);
    const entry = yield* find(sandboxId);
    if (entry.sandbox.state !== "archived") archive(entry, now);
  });

  /** After a call took effect at Boat, loses its reply as a dropped connection would. */
  const maybeLoseReply = Effect.fn("FakeBoat.maybeLoseReply")(function* (name: string) {
    if (lostResponses.delete(name)) return yield* new BoatApiError({ category: "unavailable" });
  });

  const api = BoatApi.of({
    account: Effect.fn("FakeBoat.account")(function* (key) {
      yield* enter("account", key);
      return { accountId: "acct_fake", label: "fake@boat.dev", zeroDataRetention: false };
    }),
    create: Effect.fn("FakeBoat.createWithReply")(function* (key, request) {
      const sandbox = yield* createSandbox(key, request);
      yield* maybeLoseReply("create");
      return sandbox;
    }),
    get: Effect.fn("FakeBoat.get")(function* (key, sandboxId) {
      yield* enter("get", key);
      return (yield* find(sandboxId)).sandbox;
    }),
    list: Effect.fn("FakeBoat.list")(function* (key, labels) {
      yield* enter("list", key);
      return [...sandboxes.values()]
        .map((entry) => entry.sandbox)
        .filter((sandbox) =>
          Object.entries(labels).every(([name, value]) => sandbox.labels[name] === value),
        );
    }),
    stop: Effect.fn("FakeBoat.stopWithReply")(function* (key, sandboxId) {
      yield* stopSandbox(key, sandboxId);
      yield* maybeLoseReply("stop");
    }),
    resume: Effect.fn("FakeBoat.resume")(function* (key, sandboxId, ttlSeconds) {
      const now = yield* enter("resume", key);
      const entry = yield* find(sandboxId);
      if (entry.sandbox.state !== "archived") {
        return yield* new BoatApiError({
          category: "conflict",
          code: "sandbox_running_stop_first",
        });
      }
      entry.startedAt = now;
      patch(entry, {
        state: "running",
        stoppedAt: null,
        archiveAfter: iso(now + ttlSeconds * 1000),
      });
    }),
    delete: Effect.fn("FakeBoat.delete")(function* (key, sandboxId) {
      yield* enter("delete", key);
      yield* find(sandboxId);
      sandboxes.delete(sandboxId);
      const operationId = `bdop_${sandboxId.slice(3).padEnd(32, "0")}`;
      deletions.add(operationId);
      return operationId;
    }),
    deletionCompleted: Effect.fn("FakeBoat.deletionCompleted")(function* (key, operationId) {
      yield* enter("deletion", key);
      if (!deletions.has(operationId)) {
        return yield* new BoatApiError({ category: "not-found", code: "not_found" });
      }
      return true;
    }),
    usage: Effect.fn("FakeBoat.usage")(function* (key, sandboxId) {
      const now = yield* enter("usage", key);
      const entry = yield* find(sandboxId);
      const end = entry.sandbox.stoppedAt === null ? now : Date.parse(entry.sandbox.stoppedAt);
      // Small bills at half of Default's multiplier.
      const seconds = Math.max(0, Math.round((end - entry.startedAt) / 2000));
      return { seconds, dollars: seconds / 100_000, since: iso(entry.startedAt), until: iso(end) };
    }),
  });

  let bootstrapAvailable = options.bootstrapAvailable ?? true;
  const bootstrap = BoatGuestBootstrap.of({
    get available() {
      return bootstrapAvailable;
    },
    ensure: Effect.fn("FakeBoat.bootstrap")(function* ({ key, sandboxId, expected }) {
      yield* enter("bootstrap", key);
      const entry = yield* find(sandboxId);
      if (expected !== null && expected !== entry.guestId) {
        return yield* new BoatBootstrapError({ reason: "identity-mismatch" });
      }
      return { environmentId: entry.guestId, origin: `https://${sandboxId}.fake.boat.dev` };
    }),
  });

  return {
    layer: Layer.merge(Layer.succeed(BoatApi, api), Layer.succeed(BoatGuestBootstrap, bootstrap)),
    sandboxes,
    calls,
    /** The next call to `name` takes effect at Boat but its reply is lost. */
    loseNextResponse: (name: "create" | "stop") => lostResponses.add(name),
    /** The next call to `name` fails once with `error`. */
    failNext: (name: string, error: BoatApiError) => failures.set(name, error),
    /** As if Boat's TTL archived the sandbox while the controller looked away. */
    archiveExternally: (sandboxId: string, now: number) => {
      const entry = sandboxes.get(sandboxId);
      if (entry !== undefined) archive(entry, now);
    },
    /** As if the server were replaced by a build that cannot install T3. */
    setBootstrapAvailable: (available: boolean) => {
      bootstrapAvailable = available;
    },
    /** As if someone resumed the sandbox from Boat's dashboard. */
    resumeExternally: (sandboxId: string) => {
      const entry = sandboxes.get(sandboxId);
      if (entry !== undefined) {
        patch(entry, {
          state: "running",
          stoppedAt: null,
          stopStatus: entry.sandbox.stopStatus === null ? null : "superseded",
        });
      }
    },
    /** As if someone deleted the sandbox from Boat's dashboard. */
    deleteExternally: (sandboxId: string) => sandboxes.delete(sandboxId),
    /** As if bootstrap found another T3 identity on the disk. */
    replaceGuestIdentity: (sandboxId: string) => {
      const entry = sandboxes.get(sandboxId);
      if (entry !== undefined) {
        sandboxes.set(sandboxId, { ...entry, guestId: EnvironmentId.make("env-impostor") });
      }
    },
  };
}
