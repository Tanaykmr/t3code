// Owns the lifecycle of Boat machines this server created. Every accepted request is a durable
// operation row; one worker per machine runs them in order, so a phone may disconnect as soon as
// a request is accepted and a restart picks up where it stopped.
import {
  type BoatAccountStatus,
  boatAllowedActions,
  type BoatCreateInput,
  BoatError,
  type BoatErrorCode,
  type BoatFailureCode,
  type BoatLifecycle,
  type BoatLifecycleInput,
  BoatManagedId,
  type BoatOperationKind,
  type BoatOperationReceipt,
  type BoatOperationStage,
  type BoatRate,
  type BoatRequestId,
  BoatServer,
  type BoatSetApiKeyInput,
  type BoatSetApiKeyResult,
  type BoatSnapshot,
  BoatUsageSample,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { telemetryChannel } from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import {
  BoatApi,
  type BoatApiError,
  type BoatBootstrapError,
  BoatGuestBootstrap,
  type BoatKey,
  type BoatSandbox,
  isLiveState,
} from "./BoatApi.ts";
import { makeFakeBoat } from "./BoatApiFake.ts";
import * as BoatHttpApi from "./BoatHttpApi.ts";

const API_KEY_SECRET = "boat-api-key";
/** Boat keeps create idempotency keys for 24 hours; stop trusting ours a little before. */
const IDEMPOTENCY_WINDOW_MS = 23 * 60 * 60 * 1000;
/** How long label discovery keeps looking for a create that may have reached Boat. */
const DISCOVERY_GRACE_MS = IDEMPOTENCY_WINDOW_MS + 60 * 60 * 1000;
const POLL_INTERVAL = "3 seconds";
/** About ten minutes of polling before an operation waits for the next reconcile. */
const POLL_ATTEMPTS = 200;

// Boat's published list prices on the date below; usage samples carry Boat's own figures.
const RATES: ReadonlyArray<BoatRate> = [
  { size: "small", usdPerHour: 0.018, asOf: "2026-11-23" },
  { size: "default", usdPerHour: 0.036, asOf: "2026-11-23" },
];

interface ServerRow {
  readonly managed_id: string;
  readonly account_id: string;
  readonly display_name: string;
  readonly size: BoatCreateInput["size"];
  readonly ttl_seconds: number;
  readonly lifecycle: BoatLifecycle;
  readonly sandbox_id: string | null;
  readonly guest_environment_id: string | null;
  readonly origin: string | null;
  readonly observed_power: string | null;
  readonly observed_at: string | null;
  readonly auto_stop_at: string | null;
  readonly retention: BoatServer["retention"];
  readonly usage_json: string | null;
  readonly created_at: string;
  readonly last_started_at: string | null;
  readonly last_stopped_at: string | null;
  readonly boat_environment: string | null;
}

interface OperationRow {
  readonly request_id: string;
  readonly managed_id: string;
  readonly kind: BoatOperationKind;
  readonly payload_json: string;
  readonly stage: BoatOperationStage;
  readonly provider_operation_id: string | null;
  readonly failure: BoatFailureCode | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface AccountRow {
  readonly account_id: string;
  readonly boat_environment: string | null;
  readonly label: string;
  readonly status: BoatAccountStatus;
  readonly zero_data_retention: number;
}

const decodeServer = Schema.decodeUnknownOption(BoatServer);
/** Marks a stop or resume Boat acknowledged, so later passes only confirm it. */
const ACKNOWLEDGED = "acknowledged";
const SENDING = "sending:";
const SENT = "stop:";
const isBoatError = Schema.is(BoatError);
const UsageJson = Schema.fromJsonString(BoatUsageSample);
const decodeUsage = Schema.decodeUnknownOption(UsageJson);
const encodeUsage = Schema.encodeEffect(UsageJson);

/** Raised before anything reached Boat; settles the operation without cleanup. */
class OperationRefused extends Schema.TaggedError<OperationRefused>()("OperationRefused", {
  code: Schema.Literals(["bootstrap-unavailable", "provider-rejected", "provider-unavailable"]),
}) {}

/** Raised inside a run to settle its operation as failed with a safe code. */
class OperationFailed extends Schema.TaggedError<OperationFailed>()("OperationFailed", {
  code: Schema.String,
}) {}

function failureCode(error: BoatApiError | BoatBootstrapError): BoatFailureCode {
  if (error._tag === "BoatBootstrapError") return "bootstrap-failed";
  switch (error.category) {
    case "unauthorized":
      return "unauthorized";
    case "quota-exceeded":
      return "quota-exceeded";
    case "rate-limited":
    case "unavailable":
      return "provider-unavailable";
    case "not-found":
      return "not-found";
    case "snapshot-expired":
      return "snapshot-expired";
    case "conflict":
    case "rejected":
      return "provider-rejected";
  }
}

/** Live again although our own stop (by Boat's ID) is over: started outside T3. */
const startedAfterStop = (sandbox: BoatSandbox, ourStopId: string | null) =>
  ourStopId !== null &&
  sandbox.stopId === ourStopId &&
  isLiveState(sandbox.state) &&
  (sandbox.stopStatus === "completed" || sandbox.stopStatus === "superseded");

const isTransient = (error: BoatApiError) =>
  error.category === "rate-limited" ||
  error.category === "unavailable" ||
  (error.category === "conflict" && error.code === "idempotency_in_progress");

const retryTransient = <A, R>(effect: Effect.Effect<A, BoatApiError, R>) =>
  effect.pipe(
    Effect.retry({ schedule: Schedule.exponential("1 second"), times: 4, while: isTransient }),
  );

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const fail = (code: BoatErrorCode, message: string) =>
  Effect.fail(new BoatError({ code, message }));

/** Request payloads compared on a repeated request ID; fixed field order keeps them stable. */
const createPayload = (input: BoatCreateInput) =>
  [input.displayName, input.size, String(input.ttlSeconds)].join("\u0000");

export class BoatService extends Context.Service<
  BoatService,
  {
    readonly snapshots: Stream.Stream<BoatSnapshot>;
    readonly create: (input: BoatCreateInput) => Effect.Effect<BoatOperationReceipt, BoatError>;
    readonly stop: (input: BoatLifecycleInput) => Effect.Effect<BoatOperationReceipt, BoatError>;
    readonly resume: (input: BoatLifecycleInput) => Effect.Effect<BoatOperationReceipt, BoatError>;
    readonly delete: (input: BoatLifecycleInput) => Effect.Effect<BoatOperationReceipt, BoatError>;
    readonly setApiKey: (
      input: BoatSetApiKeyInput,
    ) => Effect.Effect<BoatSetApiKeyResult, BoatError>;
    /** Runs every outstanding operation and refreshes provider observations. */
    readonly reconcile: Effect.Effect<void>;
  }
>()("t3/boat/BoatService") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const api = yield* BoatApi;
  const bootstrap = yield* BoatGuestBootstrap;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const controllerId = yield* (yield* ServerEnvironment).getEnvironmentId;
  const scope = yield* Effect.scope;

  const persistence = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Boat persistence failed.").pipe(
          Effect.annotateLogs({ cause }),
          Effect.andThen(fail("persistence", "Could not save the Boat machine state.")),
        ),
      ),
    );

  const readAccount = sql<AccountRow>`SELECT * FROM boat_account WHERE id = 1`.pipe(
    Effect.map((rows) => rows[0] ?? null),
  );
  const readServers = sql<ServerRow>`
    SELECT * FROM boat_servers WHERE deleted_at IS NULL ORDER BY created_at, rowid
  `;
  const readServer = (managedId: string) =>
    sql<ServerRow>`
      SELECT * FROM boat_servers WHERE managed_id = ${managedId} AND deleted_at IS NULL
    `.pipe(Effect.map((rows) => rows[0] ?? null));
  const readOperation = (requestId: string) =>
    sql<OperationRow>`SELECT * FROM boat_operations WHERE request_id = ${requestId}`.pipe(
      Effect.map((rows) => rows[0] ?? null),
    );
  // Insertion order breaks timestamp ties; later rows win.
  const latestOperations = sql<OperationRow>`
    SELECT * FROM boat_operations ORDER BY created_at, rowid
  `.pipe(Effect.map((rows) => new Map(rows.map((row) => [row.managed_id, row]))));
  const nextPending = (managedId: string) =>
    sql<OperationRow>`
      SELECT * FROM boat_operations
      WHERE managed_id = ${managedId} AND stage NOT IN ('completed', 'failed')
      ORDER BY created_at, rowid LIMIT 1
    `.pipe(Effect.map((rows) => rows[0] ?? null));
  const hasPendingStop = (managedId: string) =>
    sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM boat_operations
      WHERE managed_id = ${managedId} AND kind = 'stop' AND stage NOT IN ('completed', 'failed')
    `.pipe(Effect.map((rows) => (rows[0]?.n ?? 0) > 0));

  const buildSnapshot = Effect.gen(function* () {
    const [account, rows, operations] = yield* Effect.all([
      readAccount,
      readServers,
      latestOperations,
    ]);
    const servers = rows.flatMap((row) => {
      const operation = operations.get(row.managed_id);
      const decoded = decodeServer({
        managedId: row.managed_id,
        displayName: row.display_name,
        size: row.size,
        ttlSeconds: row.ttl_seconds,
        lifecycle: row.lifecycle,
        operation:
          operation === undefined
            ? null
            : {
                kind: operation.kind,
                requestId: operation.request_id,
                stage: operation.stage,
                failure: operation.failure,
                updatedAt: operation.updated_at,
              },
        sandboxId: row.sandbox_id,
        guestEnvironmentId: row.guest_environment_id,
        origin: row.origin,
        observedPower: row.observed_power,
        observedAt: row.observed_at,
        autoStopAt: row.auto_stop_at,
        retention: row.retention,
        usage: row.usage_json === null ? null : Option.getOrNull(decodeUsage(row.usage_json)),
        createdAt: row.created_at,
        lastStartedAt: row.last_started_at,
        lastStoppedAt: row.last_stopped_at,
      });
      return Option.isSome(decoded) ? [decoded.value] : [];
    });
    return {
      account:
        account === null
          ? { status: "missing" as const, label: null }
          : {
              status: account.status,
              label: account.label,
              ...(account.boat_environment === null
                ? {}
                : { environment: account.boat_environment }),
            },
      rates: RATES,
      servers,
      createAvailable: bootstrap.available,
    } satisfies BoatSnapshot;
  });

  const snapshotRef = yield* SubscriptionRef.make<BoatSnapshot>(
    yield* buildSnapshot.pipe(Effect.orDie),
  );
  const publish = buildSnapshot.pipe(
    Effect.flatMap((snapshot) => SubscriptionRef.set(snapshotRef, snapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not refresh the Boat snapshot.").pipe(
        Effect.annotateLogs({ cause }),
      ),
    ),
  );

  const readKey = secrets
    .get(API_KEY_SECRET)
    .pipe(
      Effect.map(Option.map((bytes): BoatKey => Redacted.make(new TextDecoder().decode(bytes)))),
    );

  const locks = new Map<string, Semaphore.Semaphore>();
  // Key changes and create acceptance take turns, so no create binds to a key being replaced.
  const accountLock = Semaphore.makeUnsafe(1);
  const credentialLock = Semaphore.makeUnsafe(1);
  let keyGeneration = 0;
  const readCredentials = credentialLock.withPermits(1)(
    Effect.gen(function* () {
      const [key, account] = yield* Effect.all([readKey, readAccount]);
      return { key, account, generation: keyGeneration };
    }),
  );
  const storeCredentials = (
    key: string | null,
    updateAccount: Effect.Effect<unknown, SqlError.SqlError>,
  ) =>
    credentialLock.withPermits(1)(
      persistence(
        (key === null
          ? secrets.remove(API_KEY_SECRET)
          : secrets.set(API_KEY_SECRET, new TextEncoder().encode(key))
        ).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              keyGeneration += 1;
            }),
          ),
          Effect.andThen(updateAccount),
          Effect.uninterruptible,
        ),
      ),
    );
  const lockFor = (managedId: string) => {
    let lock = locks.get(managedId);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(managedId, lock);
    }
    return lock;
  };

  const setServer = Effect.fn("BoatService.setServer")(function* (
    managedId: string,
    fields: Partial<Omit<ServerRow, "managed_id">>,
  ) {
    yield* sql`UPDATE boat_servers SET ${sql.update(fields)} WHERE managed_id = ${managedId}`;
    yield* publish;
  });

  const setStage = Effect.fn("BoatService.setStage")(function* (
    requestId: string,
    stage: BoatOperationStage,
    extra: { readonly failure?: BoatFailureCode; readonly provider_operation_id?: string } = {},
  ) {
    const updatedAt = yield* nowIso;
    yield* sql`
      UPDATE boat_operations SET ${sql.update({ stage, updated_at: updatedAt, ...extra })}
      WHERE request_id = ${requestId}
    `;
    yield* publish;
  });

  const observe = Effect.fn("BoatService.observe")(function* (
    managedId: string,
    sandbox: BoatSandbox,
  ) {
    const observedAt = yield* nowIso;
    const expired =
      sandbox.dataExpiredAt !== null && Date.parse(sandbox.dataExpiredAt) <= Date.parse(observedAt);
    yield* setServer(managedId, {
      observed_power: isLiveState(sandbox.state)
        ? "running"
        : sandbox.state === "archived"
          ? "stopped"
          : sandbox.state === "archiving"
            ? "stopping"
            : null,
      observed_at: observedAt,
      auto_stop_at: sandbox.archiveAfter,
      retention:
        sandbox.state !== "archived"
          ? "unknown"
          : expired || sandbox.snapshotAvailable === false
            ? "expired"
            : sandbox.snapshotAvailable === true
              ? "available"
              : "unknown",
    });
  });

  const observeMissing = Effect.fn("BoatService.observeMissing")(function* (managedId: string) {
    yield* setServer(managedId, {
      observed_power: "missing",
      observed_at: yield* nowIso,
      auto_stop_at: null,
      retention: "expired",
    });
  });

  /** Polls one sandbox until `done`, recording each observation. None when polling ran out. */
  const pollUntil = Effect.fn("BoatService.pollUntil")(function* (
    key: BoatKey,
    managedId: string,
    sandboxId: string,
    done: (sandbox: BoatSandbox) => boolean,
    options: { readonly yieldTo?: Effect.Effect<boolean, SqlError.SqlError> } = {},
  ) {
    for (let attempt = 0; ; attempt++) {
      const sandbox = yield* retryTransient(api.get(key, sandboxId));
      yield* observe(managedId, sandbox);
      if (done(sandbox)) return Option.some(sandbox);
      // Returns the unfinished observation when other queued work should go first.
      if (options.yieldTo !== undefined && (yield* options.yieldTo)) return Option.some(sandbox);
      if (sandbox.state === "error" || sandbox.state === "cancelled") {
        return yield* new OperationFailed({ code: "provider-rejected" });
      }
      if (attempt >= POLL_ATTEMPTS) return Option.none<BoatSandbox>();
      yield* Effect.sleep(POLL_INTERVAL);
    }
  });

  /** Usage is informational; a failed read keeps the last sample and its timestamp. */
  const updateUsage = Effect.fn("BoatService.updateUsage")(
    function* (key: BoatKey, managedId: string, sandboxId: string) {
      const usage = yield* api.usage(key, sandboxId);
      const usageJson = yield* encodeUsage({
        machineSeconds: usage.seconds,
        listPriceUsd: usage.dollars,
        windowStart: usage.since,
        windowEnd: usage.until,
        observedAt: yield* nowIso,
      });
      yield* setServer(managedId, { usage_json: usageJson });
    },
    (effect) => Effect.ignore(effect),
  );

  const bootstrapGuest = Effect.fn("BoatService.bootstrapGuest")(function* (
    key: BoatKey,
    op: OperationRow,
    server: ServerRow,
    sandboxId: string,
  ) {
    yield* setStage(op.request_id, "bootstrapping");
    const guest = yield* bootstrap.ensure({
      key,
      sandboxId,
      expected: server.guest_environment_id as EnvironmentId | null,
    });
    yield* setServer(server.managed_id, {
      guest_environment_id: guest.environmentId,
      origin: guest.origin,
      last_started_at: yield* nowIso,
    });
    // One statement, so a stop accepted during bootstrap is never overwritten by Running.
    yield* sql`
      UPDATE boat_servers SET lifecycle = 'running'
      WHERE managed_id = ${server.managed_id} AND NOT EXISTS (
        SELECT 1 FROM boat_operations
        WHERE managed_id = ${server.managed_id} AND kind = 'stop'
          AND stage NOT IN ('completed', 'failed')
      )
    `;
    yield* publish;
    yield* updateUsage(key, server.managed_id, sandboxId);
  });

  // Each run returns false when it must wait for a later pass (Boat still settling).

  const runCreate = Effect.fn("BoatService.runCreate")(function* (
    key: BoatKey,
    op: OperationRow,
    server: ServerRow,
  ) {
    // A create this server cannot finish is refused before Boat sees it. One that may already
    // have been sent (it left "queued") is only discovered, so an accepted machine is not lost.
    const discoverOnly = server.sandbox_id === null && !bootstrap.available;
    if (discoverOnly && op.stage === "queued") {
      return yield* new OperationRefused({ code: "bootstrap-unavailable" });
    }
    yield* setStage(op.request_id, "allocating");
    let sandboxId = server.sandbox_id;
    if (sandboxId === null) {
      const labels = {
        "t3.role": "environment",
        "t3.controller": controllerId,
        "t3.managed": server.managed_id,
      };
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      let sandbox: BoatSandbox;
      if (!discoverOnly && now - Date.parse(op.created_at) < IDEMPOTENCY_WINDOW_MS) {
        const created = yield* retryTransient(
          api.create(key, {
            idempotencyKey: op.request_id,
            name: server.display_name,
            size: server.size,
            ttlSeconds: server.ttl_seconds,
            labels,
            environment: server.boat_environment,
          }),
        ).pipe(
          Effect.asSome,
          // An unreadable 2xx may still mean Boat allocated it, so it is replayed too.
          Effect.catchIf(
            (error) => isTransient(error) || error.code === "decode",
            () => Effect.succeedNone,
          ),
        );
        // Boat may have accepted it: keep the operation pending and replay the same key later.
        if (Option.isNone(created)) return false;
        sandbox = created.value;
      } else {
        // The key no longer fences allocation: adopt exactly one labeled match, never create.
        const listed = yield* retryTransient(api.list(key, labels)).pipe(
          Effect.asSome,
          Effect.catchIf(isTransient, () => Effect.succeedNone),
        );
        if (Option.isNone(listed)) return false;
        const matches = listed.value;
        const [only] = matches;
        // Boat may list an accepted machine a little later; keep looking before giving up.
        if (matches.length === 0 && now - Date.parse(op.created_at) < DISCOVERY_GRACE_MS) {
          return false;
        }
        if (matches.length !== 1 || only === undefined) {
          return yield* new OperationFailed({ code: "unresolved-create" });
        }
        sandbox = only;
      }
      sandboxId = sandbox.id;
      yield* setServer(server.managed_id, { sandbox_id: sandboxId });
    }
    const settledState = yield* pollUntil(
      key,
      server.managed_id,
      sandboxId,
      (s) => isLiveState(s.state) || s.state === "archived",
    );
    if (Option.isNone(settledState)) return false;
    // A stop requested during provisioning wins before the guest is exposed.
    if (yield* hasPendingStop(server.managed_id)) return true;
    if (settledState.value.state === "archived") {
      // Boat's TTL archived it while the controller was away; nothing is billing.
      yield* setServer(server.managed_id, {
        lifecycle: "stopped",
        last_stopped_at: settledState.value.stoppedAt ?? (yield* nowIso),
      });
      return true;
    }
    yield* bootstrapGuest(key, op, server, sandboxId);
    return true;
  });

  const runStop = Effect.fn("BoatService.runStop")(function* (
    key: BoatKey,
    op: OperationRow,
    server: ServerRow,
  ) {
    const sandboxId = server.sandbox_id;
    if (sandboxId === null) {
      // The create never allocated a machine, so there is nothing to stop; leave it settled.
      yield* setServer(server.managed_id, { lifecycle: "failed" });
      return true;
    }
    // Marker: "sending:<before>" until Boat answers, then "stop:<ours>|<before>", where <before>
    // is the stop ID Boat showed before sending ("" when none) and <ours> may be "" if Boat
    // answered without one.
    const marker = op.provider_operation_id ?? "";
    const sentEarlier = marker.startsWith(SENT);
    const [ourPart = "", beforePart = ""] = sentEarlier ? marker.slice(SENT.length).split("|") : [];
    let ourStopId = sentEarlier ? ourPart || null : null;
    let before = sentEarlier ? beforePart || null : marker.slice(SENDING.length) || null;
    const record = (id: string | null) =>
      setStage(op.request_id, "stopping", {
        provider_operation_id: `${SENT}${id ?? ""}|${before ?? ""}`,
      });
    yield* setStage(op.request_id, "stopping");
    yield* setServer(server.managed_id, { lifecycle: "stopping" });
    const current = yield* retryTransient(api.get(key, sandboxId)).pipe(
      Effect.asSome,
      Effect.catchIf(isTransient, () => Effect.succeedNone),
    );
    // Never act unseen: without a fresh read the stop waits for the next pass.
    if (Option.isNone(current)) return false;
    const seen = current.value;
    yield* observe(server.managed_id, seen);
    // A stop newer than the one seen before sending is ours (a lost reply, or an ID-less answer).
    const newer = seen.stopId !== null && seen.stopId !== before;
    if ((marker.startsWith(SENDING) || (sentEarlier && ourStopId === null)) && newer) {
      ourStopId = seen.stopId;
      yield* record(ourStopId);
    }
    if (!sentEarlier && ourStopId === null) {
      if (
        seen.stopId !== null &&
        (seen.stopStatus === "pending" || seen.stopStatus === "failing")
      ) {
        // Boat is already stopping it; another send would only coalesce into that stop.
        ourStopId = seen.stopId;
        yield* record(ourStopId);
      } else if (seen.state !== "archived") {
        before = seen.stopId;
        yield* setStage(op.request_id, "stopping", {
          provider_operation_id: SENDING + (before ?? ""),
        });
        // Sent once per pass: a lost reply leaves the operation pending for the next look.
        ourStopId = yield* api.stop(key, sandboxId);
        yield* record(ourStopId);
      }
    }
    // Only our own stop being over, or a stop newer than both ours and the one before it, says
    // an outside start overtook it; a stale read still showing the older stop does not.
    const overtaken = (sandbox: BoatSandbox) =>
      startedAfterStop(sandbox, ourStopId) ||
      (sentEarlier &&
        ourStopId !== null &&
        isLiveState(sandbox.state) &&
        sandbox.stopId !== null &&
        sandbox.stopId !== ourStopId &&
        sandbox.stopId !== before);
    if (overtaken(seen)) return yield* new OperationRefused({ code: "provider-rejected" });
    const archived = yield* pollUntil(
      key,
      server.managed_id,
      sandboxId,
      (s) => s.state === "archived" || overtaken(s),
    );
    if (Option.isNone(archived)) return false;
    if (archived.value.state !== "archived") {
      return yield* new OperationRefused({ code: "provider-rejected" });
    }
    yield* setServer(server.managed_id, {
      lifecycle: "stopped",
      last_stopped_at: archived.value.stoppedAt ?? (yield* nowIso),
    });
    yield* updateUsage(key, server.managed_id, sandboxId);
    return true;
  });

  const runResume = Effect.fn("BoatService.runResume")(function* (
    key: BoatKey,
    op: OperationRow,
    server: ServerRow,
  ) {
    const sandboxId = server.sandbox_id;
    if (sandboxId === null) return yield* new OperationFailed({ code: "not-found" });
    if (!bootstrap.available && op.stage === "queued") {
      return yield* new OperationRefused({ code: "bootstrap-unavailable" });
    }
    // A stop queued behind this resume wins rather than waiting on Boat to accept a wake.
    if (op.stage === "queued" && (yield* hasPendingStop(server.managed_id))) {
      return yield* new OperationRefused({ code: "provider-unavailable" });
    }
    yield* setStage(op.request_id, "resuming");
    yield* setServer(server.managed_id, { lifecycle: "provisioning" });
    // Only an archived machine is woken; one already waking or live is just watched, since a
    // resume whose reply was lost may have been accepted.
    const current = yield* retryTransient(api.get(key, sandboxId));
    yield* observe(server.managed_id, current);
    // A stop is waiting and the machine is not up: never wake it again, hand off to the stop.
    if (!isLiveState(current.state) && (yield* hasPendingStop(server.managed_id))) {
      return yield* new OperationRefused({ code: "provider-unavailable" });
    }
    // Boat took this resume earlier; archived now means it woke and its deadline passed.
    // Settle as stopped rather than waking it again with a fresh deadline.
    if (op.provider_operation_id === ACKNOWLEDGED && current.state === "archived") {
      yield* setServer(server.managed_id, {
        last_stopped_at: current.stoppedAt ?? (yield* nowIso),
      });
      // One statement, so a stop accepted meanwhile keeps the row Stopping.
      yield* sql`
        UPDATE boat_servers SET lifecycle = CASE WHEN EXISTS (
          SELECT 1 FROM boat_operations
          WHERE managed_id = ${server.managed_id} AND kind = 'stop'
            AND stage NOT IN ('completed', 'failed')
        ) THEN 'stopping' ELSE 'stopped' END
        WHERE managed_id = ${server.managed_id}
      `;
      yield* publish;
      return true;
    }
    // This build cannot verify a guest: never wake one; one already woken is failed below.
    if (!bootstrap.available && current.state === "archived") {
      return yield* new OperationRefused({ code: "bootstrap-unavailable" });
    }
    if (current.state === "archived") {
      // Last look before waking it: a stop accepted since the check above still wins.
      if (yield* hasPendingStop(server.managed_id)) {
        return yield* new OperationRefused({ code: "provider-unavailable" });
      }
      // Sent once per pass: a later pass looks at the machine again before any resend.
      const sent = yield* api
        .resume(key, sandboxId, server.ttl_seconds, server.boat_environment)
        .pipe(
          Effect.as("sent" as const),
          Effect.catchIf(isTransient, () => Effect.succeed("unknown" as const)),
          Effect.catchIf(
            (error) => error.category === "conflict",
            () => Effect.succeed("refused" as const),
          ),
        );
      if (sent === "sent") {
        yield* setStage(op.request_id, "resuming", { provider_operation_id: ACKNOWLEDGED });
      }
      if (sent === "unknown") {
        if (!(yield* hasPendingStop(server.managed_id))) return false;
        // A stop is waiting: look once. Only a machine already live continues (the stop then
        // runs); anything else, including a failed look, hands off to the stop.
        const after = yield* retryTransient(api.get(key, sandboxId)).pipe(
          Effect.asSome,
          Effect.catch(() => Effect.succeedNone),
        );
        if (Option.isSome(after)) yield* observe(server.managed_id, after.value);
        if (Option.isNone(after) || !isLiveState(after.value.state)) {
          return yield* new OperationRefused({ code: "provider-unavailable" });
        }
      }
      if (sent === "refused") {
        const after = yield* retryTransient(api.get(key, sandboxId));
        yield* observe(server.managed_id, after);
        if (after.state === "archiving") return false;
        // Still archived after a refusal is a definite no: nothing woke, so nothing to stop.
        if (after.state === "archived") {
          return yield* new OperationRefused({ code: "provider-rejected" });
        }
      }
    }
    // A machine that has not come up yet hands off as soon as a stop is waiting.
    const live = yield* pollUntil(key, server.managed_id, sandboxId, (s) => isLiveState(s.state), {
      yieldTo: hasPendingStop(server.managed_id),
    });
    if (Option.isNone(live)) return false;
    if (!isLiveState(live.value.state)) {
      return yield* new OperationRefused({ code: "provider-unavailable" });
    }
    // This build cannot verify a guest. Nothing proves this controller woke it (it may have been
    // started from Boat's dashboard), so refuse without a cleanup stop; the row shows it live.
    if (!bootstrap.available) return yield* new OperationRefused({ code: "bootstrap-unavailable" });
    yield* bootstrapGuest(key, op, server, sandboxId);
    return true;
  });

  const runDelete = Effect.fn("BoatService.runDelete")(function* (
    key: BoatKey,
    op: OperationRow,
    server: ServerRow,
  ) {
    yield* setStage(op.request_id, "deleting");
    yield* setServer(server.managed_id, { lifecycle: "deleting" });
    if (server.sandbox_id !== null) {
      let operationId = op.provider_operation_id;
      if (operationId === null) {
        // Purge only what Boat reports archived right now, on the same account.
        const current = yield* retryTransient(api.get(key, server.sandbox_id)).pipe(
          Effect.asSome,
          Effect.catchIf(
            (error) => error.category === "not-found",
            () => Effect.succeedNone,
          ),
        );
        if (Option.isSome(current) && current.value.state !== "archived") {
          yield* observe(server.managed_id, current.value);
          if (current.value.state === "archiving") return false;
          if (current.value.state === "error" || current.value.state === "cancelled") {
            return yield* new OperationFailed({ code: "provider-rejected" });
          }
          return yield* new OperationFailed({ code: "machine-running" });
        }
        // Not retried in place: a later pass looks at the machine again before sending it.
        const attempt = Option.isNone(current)
          ? Option.some(Option.none<string>())
          : yield* api.delete(key, server.sandbox_id).pipe(
              Effect.map((id) => Option.some(Option.some(id))),
              Effect.catchIf(
                (error) => error.category === "not-found",
                () => Effect.succeedSome(Option.none<string>()),
              ),
              Effect.catchIf(isTransient, () => Effect.succeedNone),
            );
        if (Option.isNone(attempt)) return false;
        const accepted = attempt.value;
        if (Option.isSome(accepted)) {
          operationId = accepted.value;
          yield* setStage(op.request_id, "deleting", { provider_operation_id: operationId });
        } else {
          // Absent for a key that still authenticates; with no receipt, purge status is unknown.
          yield* retryTransient(api.account(key));
        }
      }
      const target = server.sandbox_id;
      if (operationId !== null) {
        let completed = false;
        for (let attempt = 0; !completed && attempt < POLL_ATTEMPTS; attempt++) {
          if (attempt > 0) yield* Effect.sleep(POLL_INTERVAL);
          completed = yield* retryTransient(api.deletionCompleted(key, operationId)).pipe(
            // Boat refuses deletion status to organization keys (seen live); there the sandbox
            // answering 404 is the best evidence, and purge completion stays unconfirmed.
            Effect.catchIf(
              (error) => error.code === "api_key_org_forbidden",
              () =>
                api.get(key, target).pipe(
                  Effect.as(false),
                  Effect.catchIf(
                    (error) => error.category === "not-found",
                    () => Effect.succeed(true),
                  ),
                ),
            ),
          );
        }
        if (!completed) return false;
      }
    }
    const now = yield* nowIso;
    yield* sql`
      UPDATE boat_servers SET observed_power = 'missing', observed_at = ${now}, deleted_at = ${now}
      WHERE managed_id = ${server.managed_id}
    `;
    return true;
  });

  const settleFailure = Effect.fn("BoatService.settleFailure")(function* (
    op: OperationRow,
    failure: BoatFailureCode,
  ) {
    yield* Effect.logWarning("Boat operation failed.").pipe(
      Effect.annotateLogs({ "boat.operation": op.kind, "boat.failure": failure }),
    );
    const server = yield* readServer(op.managed_id);
    if (server !== null) {
      // Stop and Delete stay available from Failed while the machine is known.
      yield* setServer(
        op.managed_id,
        op.kind === "resume" && failure === "snapshot-expired"
          ? { lifecycle: "stopped", retention: "expired" }
          : failure === "machine-running"
            ? // Restarted outside T3 after it stopped; show it running so Stop comes first.
              { lifecycle: "running" }
            : { lifecycle: "failed" },
      );
      // A failed create or resume must not keep billing: ask Boat to stop what this server owns.
      if ((op.kind === "create" || op.kind === "resume") && server.sandbox_id !== null) {
        const key = yield* readKey;
        if (Option.isSome(key)) yield* api.stop(key.value, server.sandbox_id).pipe(Effect.ignore);
      }
    }
    yield* setStage(op.request_id, "failed", { failure });
    return true;
  });

  const settleRefusal = Effect.fn("BoatService.settleRefusal")(function* (
    op: OperationRow,
    failure: OperationRefused["code"],
  ) {
    // No cleanup stop. The row shows what Boat last reported (a create that never allocated is
    // Failed), or Stopping while another accepted stop waits, so nothing acts on a stale state.
    const server = yield* readServer(op.managed_id);
    const lifecycle: BoatLifecycle =
      op.kind === "create" && server?.sandbox_id == null
        ? "failed"
        : server?.observed_power === "running"
          ? "running"
          : "stopped";
    // One statement, so a stop accepted meanwhile keeps the row Stopping.
    yield* sql`
      UPDATE boat_servers SET lifecycle = CASE WHEN EXISTS (
        SELECT 1 FROM boat_operations
        WHERE managed_id = ${op.managed_id} AND kind = 'stop' AND request_id != ${op.request_id}
          AND stage NOT IN ('completed', 'failed')
      ) THEN 'stopping' ELSE ${lifecycle} END
      WHERE managed_id = ${op.managed_id}
    `;
    yield* publish;
    yield* setStage(op.request_id, "failed", { failure });
    return true;
  });

  const runOperation = Effect.fn("BoatService.runOperation")(
    function* (op: OperationRow) {
      const server = yield* readServer(op.managed_id);
      if (server === null) return yield* new OperationFailed({ code: "not-found" });
      const { key, account, generation } = yield* readCredentials;
      // A record is managed only with the account that created it.
      if (Option.isNone(key) || account === null || account.account_id !== server.account_id) {
        return yield* new OperationFailed({ code: "unauthorized" });
      }
      const run =
        op.kind === "create"
          ? runCreate
          : op.kind === "stop"
            ? runStop
            : op.kind === "resume"
              ? runResume
              : runDelete;
      const done = yield* run(key.value, op, server).pipe(
        Effect.catchIf(
          (error) => error._tag === "BoatApiError" && error.category === "unauthorized",
          (error) =>
            credentialLock.withPermits(1)(
              Effect.gen(function* () {
                // Reload the operation and its provider marker before retrying with the new key.
                if (generation !== keyGeneration) return "retry" as const;
                yield* sql`UPDATE boat_account SET status = 'invalid' WHERE id = 1`;
                return yield* error;
              }),
            ),
        ),
      );
      if (done === true) yield* setStage(op.request_id, "completed");
      return done;
    },
    (effect, op) =>
      effect.pipe(
        Effect.catchTags({
          OperationRefused: (refusal) => settleRefusal(op, refusal.code),
          BoatApiError: (error) =>
            isTransient(error)
              ? // Boat did not answer: keep the operation for the next pass rather than fail it.
                // A resume with a stop waiting hands off instead, so the stop is not held up.
                op.kind === "resume" || op.kind === "create"
                ? Effect.all([hasPendingStop(op.managed_id), readServer(op.managed_id)]).pipe(
                    Effect.flatMap(([stopWaiting, row]) =>
                      // A create hands off only once its machine is known, so the stop can act.
                      stopWaiting && (op.kind === "resume" || row?.sandbox_id != null)
                        ? settleRefusal(op, "provider-unavailable")
                        : Effect.succeed(false),
                    ),
                  )
                : Effect.succeed(false)
              : settleFailure(op, failureCode(error)),
          BoatBootstrapError: (error) => settleFailure(op, failureCode(error)),
          OperationFailed: (error) => settleFailure(op, error.code as BoatFailureCode),
        }),
      ),
  );

  /** Runs one machine's pending operations in order; concurrent calls queue on its lock. */
  const drain = (managedId: string) =>
    lockFor(managedId)
      .withPermits(1)(
        Effect.gen(function* () {
          for (;;) {
            const op = yield* nextPending(managedId);
            if (op === null) return;
            if ((yield* runOperation(op)) === false) return;
          }
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Boat worker stopped on an unexpected error.").pipe(
            Effect.annotateLogs({ cause }),
          ),
        ),
      );

  // Starting immediately takes the lock before the command returns, so a later reconcile waits.
  const kick = (managedId: string) =>
    drain(managedId).pipe(Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid);

  /** A repeated request returns its first operation; reusing its ID otherwise conflicts. */
  const existingReceipt = Effect.fn("BoatService.existingReceipt")(function* (
    requestId: BoatRequestId,
    kind: BoatOperationKind,
    payload: string,
  ) {
    const row = yield* readOperation(requestId);
    if (row === null) return Option.none<BoatOperationReceipt>();
    if (row.kind !== kind || row.payload_json !== payload) {
      return yield* fail("conflict", "This request ID was already used for another action.");
    }
    return Option.some({ managedId: BoatManagedId.make(row.managed_id), requestId, kind });
  });

  const insertOperation = (
    requestId: string,
    managedId: string,
    kind: BoatOperationKind,
    payload: string,
    now: string,
  ) => sql`
    INSERT INTO boat_operations (request_id, managed_id, kind, payload_json, stage, created_at, updated_at)
    VALUES (${requestId}, ${managedId}, ${kind}, ${payload}, 'queued', ${now}, ${now})
  `;

  /** BoatErrors reach the caller; any other failure in the transaction is a persistence error. */
  const accept = Effect.fn("BoatService.accept")(function* <E, R>(
    effect: Effect.Effect<BoatOperationReceipt, E, R>,
  ) {
    const outcome = yield* sql.withTransaction(effect).pipe(Effect.result);
    if (outcome._tag === "Failure") {
      if (isBoatError(outcome.failure)) return yield* outcome.failure;
      return yield* persistence(Effect.fail(outcome.failure));
    }
    yield* publish;
    yield* kick(outcome.success.managedId);
    return outcome.success;
  });

  const create = Effect.fn("BoatService.create")(function* (input: BoatCreateInput) {
    const payload = createPayload(input);
    return yield* accountLock.withPermits(1)(
      accept(
        Effect.gen(function* () {
          const existing = yield* existingReceipt(input.requestId, "create", payload);
          if (Option.isSome(existing)) return existing.value;
          if (!bootstrap.available) {
            return yield* fail(
              "invalid-state",
              "This server cannot set up T3 Code on a Boat machine yet, so it does not create one.",
            );
          }
          const account = yield* readAccount;
          if (account === null || account.status !== "configured") {
            return yield* fail(
              "not-configured",
              "Add a working Boat API key on this server first.",
            );
          }
          if (account.zero_data_retention !== 0) {
            return yield* fail(
              "invalid-state",
              "Boat did not confirm that this account keeps stopped disks, so a stopped machine might not resume.",
            );
          }
          const managedId = BoatManagedId.make(`boat_${input.requestId}`);
          const now = yield* nowIso;
          yield* sql`
          INSERT INTO boat_servers (managed_id, account_id, display_name, size, ttl_seconds, lifecycle, retention, created_at, boat_environment)
          VALUES (${managedId}, ${account.account_id}, ${input.displayName}, ${input.size}, ${input.ttlSeconds}, 'provisioning', 'unknown', ${now}, ${account.boat_environment})
        `;
          yield* insertOperation(input.requestId, managedId, "create", payload, now);
          return { managedId, requestId: input.requestId, kind: "create" as const };
        }),
      ),
    );
  });

  const LIFECYCLE_ON_ACCEPT = {
    stop: "stopping",
    resume: "provisioning",
    delete: "deleting",
  } as const satisfies Record<Exclude<BoatOperationKind, "create">, BoatLifecycle>;

  const lifecycleCommand = (kind: Exclude<BoatOperationKind, "create">) =>
    Effect.fn(`BoatService.${kind}`)(function* (input: BoatLifecycleInput) {
      return yield* accept(
        Effect.gen(function* () {
          const existing = yield* existingReceipt(input.requestId, kind, input.managedId);
          if (Option.isSome(existing)) return existing.value;
          const server = yield* readServer(input.managedId);
          if (server === null) {
            return yield* fail("not-found", "This Boat machine no longer exists.");
          }
          const allowed = boatAllowedActions({
            lifecycle: server.lifecycle,
            sandboxId: server.sandbox_id,
            retention: server.retention,
            operation: null,
          });
          if (!allowed.has(kind) || (kind === "resume" && !bootstrap.available)) {
            return yield* fail("invalid-state", `This Boat machine cannot ${kind} right now.`);
          }
          const now = yield* nowIso;
          yield* insertOperation(input.requestId, input.managedId, kind, input.managedId, now);
          yield* sql`
            UPDATE boat_servers SET lifecycle = ${LIFECYCLE_ON_ACCEPT[kind]}
            WHERE managed_id = ${input.managedId}
          `;
          return { managedId: input.managedId, requestId: input.requestId, kind };
        }),
      );
    });

  const setApiKey = Effect.fn("BoatService.setApiKey")(function* (input: BoatSetApiKeyInput) {
    return yield* accountLock.withPermits(1)(replaceApiKey(input));
  });

  const replaceApiKey = Effect.fn("BoatService.replaceApiKey")(function* (
    input: BoatSetApiKeyInput,
  ) {
    const servers = yield* persistence(readServers);
    const current = yield* persistence(readAccount);
    if (input.apiKey === null) {
      if (servers.length > 0) {
        return yield* fail(
          "invalid-state",
          "Delete this server's Boat machines before removing the key that manages them.",
        );
      }
      yield* storeCredentials(null, sql`DELETE FROM boat_account WHERE id = 1`);
      yield* publish;
      return { status: "missing" as const };
    }
    const account = yield* api.account(Redacted.make(input.apiKey)).pipe(
      Effect.asSome,
      Effect.catchIf(
        (error) => error.category === "unauthorized",
        () => Effect.succeedNone,
      ),
      Effect.mapError(
        () => new BoatError({ code: "provider-unavailable", message: "Could not reach Boat." }),
      ),
    );
    if (Option.isNone(account)) return { status: "invalid" as const };
    // A key for another account could not inspect or clean up the machines the old one made.
    if (current !== null && current.account_id !== account.value.accountId && servers.length > 0) {
      return yield* fail(
        "conflict",
        "This key belongs to a different Boat account than the machines this server manages.",
      );
    }
    // The same user's key for another wallet passes the account check but cannot see its machines.
    if (!(yield* seesAnyMachine(Redacted.make(input.apiKey), servers))) {
      return yield* fail(
        "conflict",
        "This key cannot see the Boat machines this server manages. Use a key for the same Boat wallet.",
      );
    }
    const environment =
      input.environment === undefined ? (current?.boat_environment ?? null) : input.environment;
    // 0 only when Boat says it keeps stopped disks; an unreported policy blocks create like 1.
    yield* storeCredentials(
      input.apiKey,
      sql`
      INSERT INTO boat_account (id, account_id, label, status, zero_data_retention, boat_environment)
      VALUES (1, ${account.value.accountId}, ${account.value.label}, 'configured', ${
        account.value.zeroDataRetention === false ? 0 : 1
      }, ${environment})
      ON CONFLICT (id) DO UPDATE SET account_id = excluded.account_id, label = excluded.label,
        status = excluded.status, zero_data_retention = excluded.zero_data_retention,
        boat_environment = excluded.boat_environment
    `,
    );
    yield* publish;
    return { status: "configured" as const };
  });

  /** True when `key` can read one of the machines' sandboxes, or there is none to read. */
  const seesAnyMachine = Effect.fn("BoatService.seesAnyMachine")(function* (
    key: BoatKey,
    servers: ReadonlyArray<ServerRow>,
  ) {
    const sandboxIds = servers.flatMap((server) =>
      server.sandbox_id === null ? [] : [server.sandbox_id],
    );
    if (sandboxIds.length === 0) return true;
    for (const sandboxId of sandboxIds) {
      const seen = yield* api.get(key, sandboxId).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.category === "not-found" || error.category === "unauthorized",
          () => Effect.succeed(false),
        ),
        Effect.mapError(
          () => new BoatError({ code: "provider-unavailable", message: "Could not reach Boat." }),
        ),
      );
      if (seen) return true;
    }
    return false;
  });

  /** Refreshes one settled machine: an external archive, restart, or deletion shows up here. */
  const refresh = Effect.fn("BoatService.refresh")(
    function* (key: BoatKey, managedId: string) {
      // Read under the machine's lock; the list read before it may be stale.
      const server = yield* readServer(managedId);
      if (server === null || server.sandbox_id === null) return;
      if ((yield* nextPending(managedId)) !== null) return;
      const latest = (yield* latestOperations).get(managedId);
      const sandbox = yield* api.get(key, server.sandbox_id).pipe(
        Effect.asSome,
        Effect.catchIf(
          (error) => error.category === "not-found",
          () => Effect.succeedNone,
        ),
      );
      if (Option.isNone(sandbox)) {
        yield* observeMissing(server.managed_id);
        if (server.lifecycle === "running") {
          yield* setServer(server.managed_id, { lifecycle: "stopped" });
        }
        return;
      }
      yield* observe(server.managed_id, sandbox.value);
      if (server.lifecycle === "running" && sandbox.value.state === "archived") {
        yield* setServer(server.managed_id, {
          lifecycle: "stopped",
          last_stopped_at: sandbox.value.stoppedAt ?? (yield* nowIso),
        });
      } else if (
        server.lifecycle === "failed" &&
        isLiveState(sandbox.value.state) &&
        (latest?.kind === "create" || latest?.kind === "resume") &&
        latest.stage === "failed"
      ) {
        // A failed create or resume left it billing and the first cleanup did not land.
        yield* api.stop(key, server.sandbox_id).pipe(Effect.ignore);
      } else if (server.lifecycle === "stopped" && isLiveState(sandbox.value.state)) {
        // Restarted outside T3; show it with its new deadline rather than hiding it.
        yield* setServer(server.managed_id, { lifecycle: "running" });
      }
      if (server.lifecycle === "running" || isLiveState(sandbox.value.state)) {
        yield* updateUsage(key, server.managed_id, server.sandbox_id);
      }
    },
    (effect) => Effect.ignore(effect),
  );

  const reconcile = Effect.gen(function* () {
    const servers = yield* readServers;
    const key = yield* readKey;
    yield* Effect.forEach(
      servers,
      (server) =>
        Effect.gen(function* () {
          if ((yield* nextPending(server.managed_id)) !== null) {
            return yield* drain(server.managed_id);
          }
          if (Option.isSome(key)) {
            yield* lockFor(server.managed_id).withPermits(1)(refresh(key.value, server.managed_id));
          }
        }),
      { concurrency: 4, discard: true },
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Boat reconcile failed.").pipe(Effect.annotateLogs({ cause })),
    ),
  );

  return BoatService.of({
    snapshots: SubscriptionRef.changes(snapshotRef),
    create,
    stop: lifecycleCommand("stop"),
    resume: lifecycleCommand("resume"),
    delete: lifecycleCommand("delete"),
    setApiKey,
    reconcile,
  });
});

const layer = Layer.effect(
  BoatService,
  Effect.gen(function* () {
    const service = yield* make;
    // Startup recovery, then a jittered pass about once a minute.
    yield* service.reconcile.pipe(
      Effect.repeat(Schedule.spaced("60 seconds").pipe(Schedule.jittered)),
      Effect.forkScoped,
    );
    return service;
  }),
);

// Source builds may swap Boat for an in-memory fake (key `boat_fake_valid_key`) so the clients can
// be exercised without a wallet. Release builds always talk to Boat.
const layerProvider = Layer.unwrap(
  Effect.gen(function* () {
    const fake =
      telemetryChannel === "dev" &&
      (yield* Config.Boolean("T3CODE_DEV_BOAT_FAKE").pipe(
        Config.withDefault(false),
        Effect.orElseSucceed(() => false),
      ));
    return fake
      ? makeFakeBoat({ latency: Effect.sleep("1500 millis") }).layer
      : Layer.merge(BoatHttpApi.layer, BoatHttpApi.layerBootstrapUnavailable);
  }),
);

export const layerLive = layer.pipe(Layer.provide(layerProvider));
