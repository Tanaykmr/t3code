// Owns the lifecycle of Boat machines this server created. Every accepted request is a durable
// operation row; one worker per machine runs them in order, so a phone may disconnect as soon as
// a request is accepted and a restart picks up where it stopped.
import {
  type BoatAccountStatus,
  boatAllowedActions,
  type BoatCreateInput,
  BoatError,
  type BoatErrorCode,
  type BoatForgetInput,
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
  BOAT_LOGIN_ACCOUNT_ID_PREFIX,
  BoatApi,
  type BoatAccount,
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
const CLEANUP_ACCESS = { lookup: 1, stop: 2, delete: 4, retention: 8 } as const;

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
  readonly cleanup_denied: number;
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
const NO_ALLOCATION = "no-allocation";
const CREATE_SENT_AT = "create-sent-at:";
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
    case "forbidden":
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

const isRejectedKey = (error: BoatApiError) =>
  error.category === "unauthorized" ||
  error.code === "api_key_expired" ||
  error.code === "api_key_revoked";

const isHiddenMachine = (error: BoatApiError) =>
  error.category === "not-found" || error.category === "forbidden";

const ProviderRead = Context.Reference<((observed: boolean) => void) | null>(
  "t3/boat/ProviderRead",
  { defaultValue: () => null },
);

const trackProvider = <A>(
  request: Effect.Effect<A, BoatApiError>,
  hasEvidence: (value: A) => boolean = () => true,
) =>
  Effect.flatMap(ProviderRead, (record) =>
    record === null
      ? request
      : request.pipe(
          Effect.tap((value) =>
            Effect.sync(() => {
              if (hasEvidence(value)) record(true);
            }),
          ),
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (isTransient(error) || isRejectedKey(error) || error.code === "decode") {
                record(false);
              }
            }),
          ),
        ),
  );

const isUnsentCreate = (server: ServerRow, operation: OperationRow | null) =>
  server.sandbox_id === null &&
  operation?.kind === "create" &&
  operation.stage === "queued" &&
  operation.provider_operation_id === null;

const hasNoAllocation = (server: ServerRow, create: OperationRow | null) =>
  server.sandbox_id === null &&
  (create?.provider_operation_id === NO_ALLOCATION || isUnsentCreate(server, create));

const retryTransient = <A, R>(effect: Effect.Effect<A, BoatApiError, R>) =>
  effect.pipe(
    Effect.retry({ schedule: Schedule.exponential("1 second"), times: 4, while: isTransient }),
  );

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const fail = (code: BoatErrorCode, message: string) =>
  Effect.fail(new BoatError({ code, message }));

const providerUnavailable = () =>
  new BoatError({ code: "provider-unavailable", message: "Could not reach Boat." });

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
    readonly forget: (input: BoatForgetInput) => Effect.Effect<void, BoatError>;
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
  const readSandbox = (key: BoatKey, sandboxId: string) =>
    trackProvider(retryTransient(api.get(key, sandboxId)));

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
  const readCreate = (managedId: string) =>
    sql<OperationRow>`
      SELECT * FROM boat_operations WHERE managed_id = ${managedId} AND kind = 'create'
    `.pipe(Effect.map((rows) => rows[0] ?? null));
  // Insertion order breaks timestamp ties; later rows win.
  const latestOperation = (managedId: string) =>
    sql<OperationRow>`
    SELECT * FROM boat_operations WHERE managed_id = ${managedId}
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `.pipe(Effect.map((rows) => rows[0]));
  const latestOperations = sql<OperationRow>`
    SELECT op.* FROM boat_servers AS server
    JOIN boat_operations AS op ON op.rowid = (
      SELECT rowid FROM boat_operations WHERE managed_id = server.managed_id
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    )
    WHERE server.deleted_at IS NULL
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

  let providerStale = true;
  let reconcilePass = 0;
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
      forgetAvailable: true,
      providerStale,
    } satisfies BoatSnapshot;
  });

  const snapshotRef = yield* SubscriptionRef.make<BoatSnapshot>(
    yield* buildSnapshot.pipe(Effect.orDie),
  );
  const publish = Semaphore.makeUnsafe(1).withPermits(1)(
    buildSnapshot.pipe(
      Effect.flatMap((snapshot) => SubscriptionRef.set(snapshotRef, snapshot)),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not refresh the Boat snapshot.").pipe(
          Effect.annotateLogs({ cause }),
        ),
      ),
    ),
  );

  const readStoredKey = secrets
    .get(API_KEY_SECRET)
    .pipe(
      Effect.map(Option.map((bytes): BoatKey => Redacted.make(new TextDecoder().decode(bytes)))),
    );

  const locks = new Map<string, Semaphore.Semaphore>();
  // Key changes and create acceptance take turns, so no create binds to a key being replaced.
  const accountLock = Semaphore.makeUnsafe(1);
  const credentialLock = Semaphore.makeUnsafe(1);
  const readKey = credentialLock.withPermits(1)(readStoredKey);
  let keyGeneration = 0;
  const readCredentials = credentialLock.withPermits(1)(
    Effect.gen(function* () {
      const [key, account] = yield* Effect.all([readStoredKey, readAccount]);
      return { key, account, generation: keyGeneration };
    }),
  );
  const checkCredential = Effect.fn("BoatService.checkCredential")(function* (
    key: Option.Option<BoatKey>,
  ) {
    if (Option.isNone(key)) return { status: "missing" as const };
    return yield* api.account(key.value).pipe(
      Effect.map((account) => ({ status: "configured" as const, account })),
      Effect.catchIf(isRejectedKey, () => Effect.succeed({ status: "invalid" as const })),
    );
  });
  const recordCredentialStatus = Effect.fn("BoatService.recordCredentialStatus")(function* (
    status: BoatAccountStatus,
    generation: number,
    notify: Effect.Effect<void> = publish,
  ) {
    const changed = yield* credentialLock.withPermits(1)(
      Effect.suspend(() =>
        generation === keyGeneration
          ? sql`UPDATE boat_account SET status = ${status} WHERE id = 1 AND status <> ${status} RETURNING id`
          : Effect.succeed([]),
      ),
    );
    if (changed.length > 0) yield* notify;
  });
  const storeCredentials = Effect.fn("BoatService.storeCredentials")(
    function* (key: string | null, updateAccount: Effect.Effect<unknown, SqlError.SqlError>) {
      const prior = yield* secrets.get(API_KEY_SECRET);
      if (key === null) yield* secrets.remove(API_KEY_SECRET);
      else yield* secrets.set(API_KEY_SECRET, new TextEncoder().encode(key));
      yield* updateAccount.pipe(
        Effect.onError(() =>
          (Option.isSome(prior)
            ? secrets.set(API_KEY_SECRET, prior.value)
            : secrets.remove(API_KEY_SECRET)
          ).pipe(Effect.orDie),
        ),
      );
      keyGeneration += 1;
    },
    (effect) => credentialLock.withPermits(1)(persistence(Effect.uninterruptible(effect))),
  );
  // Scoped credentials can pass /me while sandbox access fails. Record only the endpoint
  // that was denied and let a successful retry of that endpoint clear the evidence.
  const trackCleanupAccess = <A>(
    request: Effect.Effect<A, BoatApiError>,
    server: ServerRow,
    generation: number,
    access: (typeof CLEANUP_ACCESS)[keyof typeof CLEANUP_ACCESS],
    visible: (value: A) => boolean = () => true,
  ) => {
    const record = (denied: boolean) =>
      ((server.cleanup_denied & access) !== 0) === denied
        ? Effect.void
        : credentialLock.withPermits(1)(
            Effect.suspend(() =>
              generation !== keyGeneration
                ? Effect.void
                : sql`
                  UPDATE boat_servers
                  SET cleanup_denied = (cleanup_denied & ${~access}) | ${denied ? access : 0}
                  WHERE managed_id = ${server.managed_id} AND deleted_at IS NULL
                `.pipe(Effect.asVoid),
            ),
          );
    return request.pipe(
      Effect.tapError((error) =>
        isRejectedKey(error) ||
        error.category === "forbidden" ||
        (access !== CLEANUP_ACCESS.retention && error.category === "not-found")
          ? record(true)
          : Effect.void,
      ),
      Effect.tap((value) => record(!visible(value))),
    );
  };
  const lockFor = (managedId: string) => {
    let lock = locks.get(managedId);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(managedId, lock);
    }
    return lock;
  };
  const fieldsChanged = (fields: Record<string, unknown>) =>
    sql.or(Object.entries(fields).map(([field, value]) => sql`${sql(field)} IS NOT ${value}`));

  const setServer = Effect.fn("BoatService.setServer")(function* (
    managedId: string,
    fields: Partial<Omit<ServerRow, "managed_id">>,
    notify: Effect.Effect<void> = publish,
  ) {
    const changed = yield* sql`
      UPDATE boat_servers SET ${sql.update(fields)} WHERE managed_id = ${managedId}
        AND ${fieldsChanged(fields)}
      RETURNING managed_id
    `;
    if (changed.length > 0) yield* notify;
  });

  const setStage = Effect.fn("BoatService.setStage")(function* (
    requestId: string,
    stage: BoatOperationStage,
    extra: { readonly failure?: BoatFailureCode; readonly provider_operation_id?: string } = {},
  ) {
    const updatedAt = yield* nowIso;
    const fields = { stage, ...extra };
    const changed = yield* sql`
      UPDATE boat_operations SET ${sql.update({ ...fields, updated_at: updatedAt })}
      WHERE request_id = ${requestId} AND ${fieldsChanged(fields)}
      RETURNING request_id
    `;
    if (changed.length > 0) yield* publish;
  });

  const observe = Effect.fn("BoatService.observe")(function* (
    managedId: string,
    sandbox: BoatSandbox,
    notify: Effect.Effect<void> = publish,
  ) {
    const observedAt = yield* nowIso;
    const expired =
      sandbox.dataExpiredAt !== null && Date.parse(sandbox.dataExpiredAt) <= Date.parse(observedAt);
    const power = isLiveState(sandbox.state)
      ? "running"
      : sandbox.state === "archived"
        ? "stopped"
        : sandbox.state === "archiving"
          ? "stopping"
          : null;
    const retention =
      sandbox.state !== "archived"
        ? "unknown"
        : expired || sandbox.snapshotAvailable === false
          ? "expired"
          : sandbox.snapshotAvailable === true
            ? "available"
            : "unknown";
    const changed = yield* sql`
      UPDATE boat_servers SET observed_power = ${power}, observed_at = ${observedAt},
        auto_stop_at = ${sandbox.archiveAfter}, retention = ${retention}
      WHERE managed_id = ${managedId} AND deleted_at IS NULL AND (
        observed_at IS NULL OR observed_power IS NOT ${power}
        OR auto_stop_at IS NOT ${sandbox.archiveAfter} OR retention IS NOT ${retention}
      ) RETURNING managed_id
    `;
    if (changed.length > 0) yield* notify;
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
      const sandbox = yield* readSandbox(key, sandboxId);
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
    function* (
      key: BoatKey,
      managedId: string,
      sandboxId: string,
      notify: Effect.Effect<void> = publish,
    ) {
      const usage = yield* trackProvider(api.usage(key, sandboxId), () => false);
      const current = (yield* readServer(managedId))?.usage_json;
      const previous = current == null ? null : Option.getOrNull(decodeUsage(current));
      if (
        previous !== null &&
        previous.machineSeconds === usage.seconds &&
        previous.listPriceUsd === usage.dollars &&
        previous.windowStart === usage.since &&
        previous.windowEnd === usage.until
      )
        return true;
      const usageJson = yield* encodeUsage({
        machineSeconds: usage.seconds,
        listPriceUsd: usage.dollars,
        windowStart: usage.since,
        windowEnd: usage.until,
        observedAt: yield* nowIso,
      });
      yield* setServer(managedId, { usage_json: usageJson }, notify);
      return true;
    },
    (effect) => effect.pipe(Effect.orElseSucceed(() => false)),
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

  const allocationLabels = (managedId: string) => ({
    "t3.role": "environment",
    "t3.controller": controllerId,
    "t3.managed": managedId,
  });

  const findAllocation = Effect.fn("BoatService.findAllocation")(function* (
    key: BoatKey,
    managedId: string,
  ) {
    const labels = allocationLabels(managedId);
    return yield* trackProvider(
      retryTransient(api.list(key, labels)).pipe(
        Effect.map((matches) => {
          const [only] = matches;
          return matches.length === 1 &&
            only !== undefined &&
            Object.entries(labels).every(([name, value]) => only.labels[name] === value)
            ? only
            : null;
        }),
      ),
      (match) => match !== null,
    );
  });

  // Each run returns false when it must wait for a later pass (Boat still settling).

  const runCreate = Effect.fn("BoatService.runCreate")(function* (
    key: BoatKey,
    op: OperationRow,
    server: ServerRow,
    generation: number,
  ) {
    // A create this server cannot finish is refused before Boat sees it. One that may already
    // have been sent (it left "queued") is only discovered, so an accepted machine is not lost.
    const discoverOnly = server.sandbox_id === null && !bootstrap.available;
    const unsent = isUnsentCreate(server, op);
    if (op.provider_operation_id === NO_ALLOCATION) {
      return yield* new OperationFailed({ code: "provider-rejected" });
    }
    if (discoverOnly && unsent) {
      yield* setStage(op.request_id, "allocating", { provider_operation_id: NO_ALLOCATION });
      return yield* new OperationRefused({ code: "bootstrap-unavailable" });
    }
    let sandboxId = server.sandbox_id;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const firstSentAt = op.provider_operation_id?.startsWith(CREATE_SENT_AT)
      ? Number(op.provider_operation_id.slice(CREATE_SENT_AT.length))
      : Date.parse(op.created_at);
    const canReplay =
      sandboxId === null && !discoverOnly && (unsent || now - firstSentAt < IDEMPOTENCY_WINDOW_MS);
    const retention = canReplay
      ? yield* ensureDiskRetention(trackProvider(api.account(key), () => false)).pipe(Effect.result)
      : null;
    const canAllocate = retention?._tag === "Success";
    if (canReplay && !canAllocate && unsent) {
      const error =
        retention?._tag === "Failure"
          ? retention.failure
          : new OperationRefused({ code: "provider-rejected" });
      if (error._tag === "BoatApiError") {
        if (isTransient(error)) return false;
        if (isRejectedKey(error)) return yield* error;
      }
      yield* setStage(op.request_id, "allocating", { provider_operation_id: NO_ALLOCATION });
      return yield* error;
    }
    yield* setStage(
      op.request_id,
      "allocating",
      canAllocate && unsent
        ? { provider_operation_id: CREATE_SENT_AT + DateTime.toEpochMillis(yield* DateTime.now) }
        : {},
    );
    if (sandboxId === null) {
      let sandbox: BoatSandbox;
      if (canAllocate) {
        const created = yield* trackProvider(
          api.create(key, {
            idempotencyKey: op.request_id,
            name: server.display_name,
            size: server.size,
            ttlSeconds: server.ttl_seconds,
            labels: allocationLabels(server.managed_id),
            environment: server.boat_environment,
          }),
        ).pipe(Effect.result);
        if (created._tag === "Failure") {
          const error = created.failure;
          // An earlier attempt might have allocated even if the current key is refused.
          if (isTransient(error) || error.code === "decode") return false;
          if (!unsent) {
            return yield* new OperationFailed({ code: "unresolved-create" });
          }
          yield* setStage(op.request_id, "allocating", { provider_operation_id: NO_ALLOCATION });
          return yield* error;
        }
        sandbox = created.success;
      } else {
        // If sending is unsafe, only adopt an exact match from an earlier attempt.
        const listed = yield* trackCleanupAccess(
          findAllocation(key, server.managed_id),
          server,
          generation,
          CLEANUP_ACCESS.lookup,
          (match) => match !== null,
        ).pipe(
          Effect.asSome,
          Effect.catchIf(
            (error) => error._tag === "BoatApiError" && isTransient(error),
            () => Effect.succeedNone,
          ),
        );
        if (Option.isNone(listed)) return false;
        if (listed.value === null) {
          if (now - firstSentAt < DISCOVERY_GRACE_MS) return false;
          return yield* new OperationFailed({ code: "unresolved-create" });
        }
        sandbox = listed.value;
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

  const refuseForbidden = <A, E extends SqlError.SqlError>(
    request: Effect.Effect<A, BoatApiError | E>,
  ) =>
    request.pipe(
      Effect.catchIf(
        (error) =>
          error._tag === "BoatApiError" && error.category === "forbidden" && !isRejectedKey(error),
        () => new OperationRefused({ code: "provider-rejected" }),
      ),
    );

  const ensureDiskRetention = Effect.fn("BoatService.ensureDiskRetention")(function* (
    account: Effect.Effect<BoatAccount, BoatApiError | SqlError.SqlError>,
  ) {
    const policy = yield* refuseForbidden(account);
    if (policy.zeroDataRetention !== false) {
      return yield* new OperationRefused({ code: "provider-rejected" });
    }
  });

  const checkStopRetention = (key: BoatKey, server: ServerRow, generation: number) =>
    ensureDiskRetention(
      trackCleanupAccess(
        trackProvider(api.account(key), () => false),
        server,
        generation,
        CLEANUP_ACCESS.retention,
      ),
    );
  const requestStop = (key: BoatKey, sandboxId: string, server: ServerRow, generation: number) =>
    trackCleanupAccess(
      trackProvider(api.stop(key, sandboxId)),
      server,
      generation,
      CLEANUP_ACCESS.stop,
    );
  const cleanupStop = Effect.fn("BoatService.cleanupStop")(
    function* (key: BoatKey, sandboxId: string, server: ServerRow, generation: number) {
      yield* checkStopRetention(key, server, generation);
      yield* requestStop(key, sandboxId, server, generation);
    },
    (effect) => Effect.ignore(effect),
  );

  const runStop = Effect.fn("BoatService.runStop")(function* (
    key: BoatKey,
    op: OperationRow,
    server: ServerRow,
    generation: number,
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
    const current = yield* trackCleanupAccess(
      readSandbox(key, sandboxId),
      server,
      generation,
      CLEANUP_ACCESS.lookup,
    ).pipe(
      Effect.asSome,
      Effect.catchIf(
        (error) => error._tag === "BoatApiError" && isTransient(error),
        () => Effect.succeedNone,
      ),
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
        yield* checkStopRetention(key, server, generation);
        before = seen.stopId;
        yield* setStage(op.request_id, "stopping", {
          provider_operation_id: SENDING + (before ?? ""),
        });
        // Sent once per pass: a lost reply leaves the operation pending for the next look.
        ourStopId = yield* refuseForbidden(requestStop(key, sandboxId, server, generation));
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
    const current = yield* readSandbox(key, sandboxId);
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
      yield* ensureDiskRetention(trackProvider(api.account(key), () => false));
      // Last look before waking it: a stop accepted since the check above still wins.
      if (yield* hasPendingStop(server.managed_id)) {
        return yield* new OperationRefused({ code: "provider-unavailable" });
      }
      // Sent once per pass: a later pass looks at the machine again before any resend.
      const sent = yield* trackProvider(
        api.resume(key, sandboxId, server.ttl_seconds, server.boat_environment),
      ).pipe(
        Effect.as("sent" as const),
        Effect.catchIf(isTransient, () => Effect.succeed("unknown" as const)),
        Effect.catchIf(
          (error) => error.category === "conflict",
          () => Effect.succeed("refused" as const),
        ),
        refuseForbidden,
      );
      if (sent === "sent") {
        yield* setStage(op.request_id, "resuming", { provider_operation_id: ACKNOWLEDGED });
      }
      if (sent === "unknown") {
        if (!(yield* hasPendingStop(server.managed_id))) return false;
        // A stop is waiting: look once. Only a machine already live continues (the stop then
        // runs); anything else, including a failed look, hands off to the stop.
        const after = yield* readSandbox(key, sandboxId).pipe(
          Effect.asSome,
          Effect.catch(() => Effect.succeedNone),
        );
        if (Option.isSome(after)) yield* observe(server.managed_id, after.value);
        if (Option.isNone(after) || !isLiveState(after.value.state)) {
          return yield* new OperationRefused({ code: "provider-unavailable" });
        }
      }
      if (sent === "refused") {
        const after = yield* readSandbox(key, sandboxId);
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
    generation: number,
  ) {
    yield* setStage(op.request_id, "deleting");
    yield* setServer(server.managed_id, { lifecycle: "deleting" });
    const target = server.sandbox_id;
    if (target === null) {
      const create = yield* readCreate(server.managed_id);
      if (create?.provider_operation_id !== NO_ALLOCATION) {
        return yield* new OperationFailed({ code: "unresolved-create" });
      }
    } else {
      let operationId = op.provider_operation_id;
      if (operationId === null) {
        // A scoped key can miss a live machine in both GET and list. Without a purge receipt,
        // neither 404 nor inventory under that key releases the controller's cleanup obligation.
        const current = yield* trackCleanupAccess(
          readSandbox(key, target),
          server,
          generation,
          CLEANUP_ACCESS.lookup,
        );
        if (
          current.state !== "archived" &&
          current.state !== "error" &&
          current.state !== "cancelled"
        ) {
          yield* observe(server.managed_id, current);
          if (current.state === "archiving") return false;
          return yield* new OperationFailed({ code: "machine-running" });
        }
        operationId = yield* trackCleanupAccess(
          trackProvider(api.delete(key, target)),
          server,
          generation,
          CLEANUP_ACCESS.delete,
        );
        yield* setStage(op.request_id, "deleting", { provider_operation_id: operationId });
      }
      let completed = false;
      for (let attempt = 0; !completed && attempt < POLL_ATTEMPTS; attempt++) {
        if (attempt > 0) yield* Effect.sleep(POLL_INTERVAL);
        const status = yield* trackProvider(
          retryTransient(api.deletionCompleted(key, operationId, target)),
        ).pipe(
          // Boat documents that accepting a purge irreversibly removes the sandbox from use.
          // Organization keys cannot read purge status, but we already persisted its receipt.
          Effect.catchIf(
            (error) => error.code === "api_key_org_forbidden",
            () => Effect.succeed(true),
          ),
          Effect.asSome,
          Effect.catchIf(
            (error) => error.category === "not-found" || error.code === "decode",
            () => Effect.succeedNone,
          ),
        );
        if (Option.isNone(status)) return false;
        completed = status.value;
      }
      if (!completed) return false;
    }
    return true;
  });

  const completeDelete = Effect.fn("BoatService.completeDelete")(function* (op: OperationRow) {
    const now = yield* nowIso;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          UPDATE boat_servers SET observed_power = 'missing', observed_at = ${now}, deleted_at = ${now}
          WHERE managed_id = ${op.managed_id}
        `;
        yield* sql`
          UPDATE boat_operations SET stage = 'completed', updated_at = ${now}
          WHERE request_id = ${op.request_id}
        `;
      }),
    );
    yield* publish;
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
      yield* setServer(
        op.managed_id,
        op.kind === "resume" && failure === "snapshot-expired"
          ? { lifecycle: "stopped", retention: "expired" }
          : failure === "machine-running"
            ? // Restarted outside T3 after it stopped; show it running so Stop comes first.
              { lifecycle: "running" }
            : { lifecycle: "failed" },
      );
      // Stop billing for a failed create or resume when Boat can keep its disk.
      if ((op.kind === "create" || op.kind === "resume") && server.sandbox_id !== null) {
        const { key, generation } = yield* readCredentials;
        if (Option.isSome(key))
          yield* cleanupStop(key.value, server.sandbox_id, server, generation);
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
      if (Option.isNone(key) && isUnsentCreate(server, op)) {
        yield* recordCredentialStatus("missing", generation);
        return false;
      }
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
      const done = yield* run(key.value, op, server, generation).pipe(
        Effect.catchIf(
          (error) => error._tag === "BoatApiError" && isRejectedKey(error),
          (error) =>
            Effect.gen(function* () {
              yield* recordCredentialStatus("invalid", generation);
              // Reload the operation and its provider marker before retrying with the new key.
              if (generation !== keyGeneration) return "retry" as const;
              if (
                op.kind === "create" &&
                isUnsentCreate(server, yield* readOperation(op.request_id))
              ) {
                return false;
              }
              return yield* error;
            }),
        ),
      );
      if (done === true) {
        if (op.kind === "delete") yield* completeDelete(op);
        else yield* setStage(op.request_id, "completed");
      }
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
          let attempted = false;
          const evidence = { observed: false, failed: false };
          const record = (observed: boolean) => {
            if (observed) evidence.observed = true;
            else evidence.failed = true;
          };
          for (;;) {
            const op = yield* nextPending(managedId);
            if (op === null) break;
            attempted = true;
            if (
              (yield* runOperation(op).pipe(Effect.provideService(ProviderRead, record))) === false
            ) {
              break;
            }
          }
          return attempted ? evidence.observed && !evidence.failed : null;
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Boat worker stopped on an unexpected error.").pipe(
            Effect.annotateLogs({ cause }),
            Effect.as(false),
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

  /** BoatErrors reach the caller; any other failure is a persistence error. */
  const accept = Effect.fn("BoatService.accept")(function* <E, R>(
    effect: Effect.Effect<BoatOperationReceipt | BoatError, E, R>,
  ) {
    const outcome = yield* effect.pipe(Effect.result);
    if (outcome._tag === "Failure") {
      if (isBoatError(outcome.failure)) return yield* outcome.failure;
      return yield* persistence(Effect.fail(outcome.failure));
    }
    yield* publish;
    // A rejection returned as a value has state changes to publish.
    if (isBoatError(outcome.success)) return yield* outcome.success;
    yield* kick(outcome.success.managedId);
    return outcome.success;
  });

  const create = Effect.fn("BoatService.create")(function* (input: BoatCreateInput) {
    const payload = createPayload(input);
    return yield* accountLock.withPermits(1)(
      accept(
        Effect.gen(function* () {
          const lookup = existingReceipt(input.requestId, "create", payload);
          const existing = yield* lookup;
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
          const denied = yield* sql`
            SELECT managed_id FROM boat_servers
            WHERE deleted_at IS NULL AND cleanup_denied <> 0 LIMIT 1
          `;
          if (denied.length > 0) {
            return yield* fail(
              "invalid-state",
              "The saved Boat key could not manage an existing machine. Restore its access or replace it before creating another machine.",
            );
          }
          const key = yield* readKey;
          if (Option.isNone(key)) {
            yield* sql`UPDATE boat_account SET status = 'missing' WHERE id = 1`;
            return new BoatError({
              code: "not-configured",
              message:
                "The saved Boat API key is missing. Enter it again in Settings → Environments → Boat machines.",
            });
          }
          const accountResult = yield* api.account(key.value).pipe(Effect.result);
          if (accountResult._tag === "Failure") {
            if (
              isRejectedKey(accountResult.failure) ||
              accountResult.failure.category === "forbidden"
            ) {
              yield* sql`UPDATE boat_account SET status = 'invalid' WHERE id = 1`;
              return new BoatError({
                code: "unauthorized",
                message:
                  "The saved Boat API key is invalid. Replace it in Settings → Environments → Boat machines.",
              });
            }
            return yield* fail("provider-unavailable", "Could not reach Boat.");
          }
          if (accountResult.success.zeroDataRetention !== false) {
            return yield* fail(
              "invalid-state",
              "Boat did not confirm that this account keeps stopped disks, so a stopped machine might not resume.",
            );
          }
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              // A lifecycle command could have claimed this request ID during the account read.
              const existing = yield* lookup;
              if (Option.isSome(existing)) return existing.value;
              const managedId = BoatManagedId.make(`boat_${input.requestId}`);
              const now = yield* nowIso;
              yield* sql`
                INSERT INTO boat_servers (managed_id, account_id, display_name, size, ttl_seconds, lifecycle, retention, created_at, boat_environment)
                VALUES (${managedId}, ${account.account_id}, ${input.displayName}, ${input.size}, ${input.ttlSeconds}, 'provisioning', 'unknown', ${now}, ${account.boat_environment})
              `;
              yield* insertOperation(input.requestId, managedId, "create", payload, now);
              return { managedId, requestId: input.requestId, kind: "create" as const };
            }),
          );
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
        }).pipe(sql.withTransaction),
      );
    });

  const setApiKey = Effect.fn("BoatService.setApiKey")(function* (input: BoatSetApiKeyInput) {
    return yield* accountLock.withPermits(1)(replaceApiKey(input));
  });

  const replaceApiKey = Effect.fn("BoatService.replaceApiKey")(function* (
    input: BoatSetApiKeyInput,
  ) {
    const servers = yield* persistence(readServers);
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
    const credentials = yield* persistence(readCredentials);
    const replacing =
      Option.isNone(credentials.key) || Redacted.value(credentials.key.value) !== input.apiKey;
    if (servers.length > 0 && replacing && servers.every((server) => server.cleanup_denied === 0)) {
      const previous = yield* checkCredential(credentials.key).pipe(
        Effect.mapError(providerUnavailable),
      );
      yield* persistence(recordCredentialStatus(previous.status, credentials.generation));
      if (previous.status === "configured") {
        return yield* fail(
          "conflict",
          "Delete this server's Boat machines before replacing the key that manages them.",
        );
      }
    }
    const key = Redacted.make(input.apiKey);
    const account = yield* checkCredential(Option.some(key)).pipe(
      Effect.catchIf(
        (error) => error.category === "forbidden",
        () => Effect.succeed({ status: "invalid" as const }),
      ),
      Effect.mapError(providerUnavailable),
    );
    if (account.status !== "configured") return { status: "invalid" as const };
    const next = account.account;
    const previousAccountId = servers[0]?.account_id;
    const rebind = previousAccountId !== undefined && previousAccountId !== next.accountId;
    const previousIsLogin = previousAccountId?.startsWith(BOAT_LOGIN_ACCOUNT_ID_PREFIX) === true;
    if (
      servers.some((server) => server.account_id !== previousAccountId) ||
      (rebind &&
        ((!previousIsLogin && !next.accountId.startsWith(BOAT_LOGIN_ACCOUNT_ID_PREFIX)) ||
          !servers.some((server) => server.sandbox_id !== null)))
    ) {
      return yield* fail(
        "conflict",
        "This key belongs to a different Boat account than the machines this server manages.",
      );
    }
    const accountId = rebind && !previousIsLogin ? previousAccountId : next.accountId;
    const recovered = new Map<string, string>();
    if (replacing || rebind) {
      for (const server of servers) {
        if (server.sandbox_id === null) {
          const create = yield* persistence(readCreate(server.managed_id));
          if (hasNoAllocation(server, create)) continue;
        }
        // Boat lists sandboxes in the candidate key's pinned wallet. A shared machine is
        // insufficient evidence of ownership.
        const match = yield* findAllocation(key, server.managed_id).pipe(
          Effect.catchIf(isHiddenMachine, () => Effect.succeed(null)),
          Effect.mapError(providerUnavailable),
        );
        if (
          match === null ||
          (match.access !== undefined && match.access !== "owner") ||
          (server.sandbox_id !== null && match.id !== server.sandbox_id)
        ) {
          return yield* fail(
            "conflict",
            "The replacement key must see every managed machine in the same Boat wallet.",
          );
        }
        const sandbox = yield* api.get(key, match.id).pipe(
          Effect.catchIf(isHiddenMachine, () => Effect.succeed(null)),
          Effect.mapError(providerUnavailable),
        );
        if (sandbox?.id !== match.id) {
          return yield* fail(
            "conflict",
            "The replacement key must be able to read every managed machine.",
          );
        }
        // A changed login must be tied to the original provider resources.
        if (
          rebind &&
          ((sandbox.access !== undefined && sandbox.access !== "owner") ||
            (match.access !== "owner" && sandbox.access !== "owner"))
        ) {
          return yield* fail(
            "conflict",
            "The replacement key must prove it owns every managed machine.",
          );
        }
        if (server.sandbox_id === null) recovered.set(server.managed_id, match.id);
      }
    }
    const environment =
      input.environment === undefined
        ? (credentials.account?.boat_environment ?? null)
        : input.environment;
    // 0 only when Boat says it keeps stopped disks; an unreported policy blocks create like 1.
    yield* storeCredentials(
      input.apiKey,
      Effect.gen(function* () {
        if (rebind && previousAccountId !== accountId)
          yield* sql`UPDATE boat_servers SET account_id = ${accountId}
            WHERE deleted_at IS NULL AND account_id = ${previousAccountId}`;
        if (replacing)
          yield* sql`UPDATE boat_servers SET cleanup_denied = 0 WHERE cleanup_denied <> 0`;
        for (const [managedId, sandboxId] of recovered) {
          yield* sql`UPDATE boat_servers SET sandbox_id = ${sandboxId}
            WHERE managed_id = ${managedId} AND sandbox_id IS NULL AND deleted_at IS NULL`;
        }
        yield* sql`
      INSERT INTO boat_account (id, account_id, label, status, zero_data_retention, boat_environment)
      VALUES (1, ${accountId}, ${next.label}, 'configured', ${
        next.zeroDataRetention === false ? 0 : 1
      }, ${environment})
      ON CONFLICT (id) DO UPDATE SET account_id = excluded.account_id, label = excluded.label,
        status = excluded.status, zero_data_retention = excluded.zero_data_retention,
        boat_environment = excluded.boat_environment
        `;
      }).pipe(sql.withTransaction),
    );
    yield* publish;
    return { status: "configured" as const };
  });

  const forget = Effect.fn("BoatService.forget")(function* (input: BoatForgetInput) {
    yield* lockFor(input.managedId).withPermits(1)(
      accountLock.withPermits(1)(
        Effect.gen(function* () {
          const server = yield* persistence(readServer(input.managedId));
          if (server === null) return;
          const key = yield* persistence(readKey);
          const noAllocation =
            server.sandbox_id === null &&
            hasNoAllocation(server, yield* persistence(readCreate(server.managed_id)));
          if (Option.isSome(key) && !noAllocation) {
            const visible = yield* (
              server.sandbox_id === null
                ? api
                    .list(key.value, allocationLabels(server.managed_id))
                    .pipe(Effect.map((matches) => matches.length > 0))
                : api.get(key.value, server.sandbox_id).pipe(Effect.as(true))
            ).pipe(
              Effect.catchIf(
                (error) => isRejectedKey(error) || isHiddenMachine(error),
                () => Effect.succeed(false),
              ),
              Effect.mapError(providerUnavailable),
            );
            if (visible)
              return yield* fail(
                "invalid-state",
                "Boat still reports this machine. Delete it before forgetting its record.",
              );
          }
          const now = yield* nowIso;
          yield* persistence(
            sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`UPDATE boat_servers SET deleted_at = ${now} WHERE managed_id = ${server.managed_id}`;
                yield* sql`UPDATE boat_operations SET stage = 'failed', failure = 'not-found', updated_at = ${now}
          WHERE managed_id = ${server.managed_id} AND stage NOT IN ('completed', 'failed')`;
              }),
            ),
          );
          yield* publish;
        }),
      ),
    );
  });

  /** Refreshes one settled machine: an external archive, restart, or deletion shows up here. */
  const refresh = Effect.fn("BoatService.refresh")(
    function* (key: BoatKey, generation: number, managedId: string, notify: typeof publish) {
      // Read under the machine's lock; the list read before it may be stale.
      const server = yield* readServer(managedId);
      if (server === null || (yield* nextPending(managedId)) !== null) return null;
      if (server.sandbox_id === null) {
        const create = yield* readCreate(managedId);
        if (create?.stage !== "failed" || create.provider_operation_id === NO_ALLOCATION)
          return null;
        // Empty scoped inventory leaves ownership intact. A later exact match can be recovered.
        const recovered = yield* trackCleanupAccess(
          findAllocation(key, managedId),
          server,
          generation,
          CLEANUP_ACCESS.lookup,
          (match) => match !== null,
        );
        if (recovered === null) return null;
        yield* setServer(managedId, { sandbox_id: recovered.id }, notify);
        yield* observe(managedId, recovered, notify);
        if (isLiveState(recovered.state)) yield* cleanupStop(key, recovered.id, server, generation);
        return true;
      }
      const sandbox = yield* trackCleanupAccess(
        api.get(key, server.sandbox_id),
        server,
        generation,
        CLEANUP_ACCESS.lookup,
      ).pipe(
        Effect.asSome,
        Effect.catchIf(
          (error) =>
            error._tag === "BoatApiError" && isHiddenMachine(error) && !isRejectedKey(error),
          () => Effect.succeedNone,
        ),
      );
      if (Option.isNone(sandbox)) {
        if (server.observed_power !== "missing") {
          yield* setServer(
            managedId,
            { observed_power: "missing", observed_at: yield* nowIso },
            notify,
          );
        }
        return null;
      }
      const seen = sandbox.value;
      yield* observe(server.managed_id, seen, notify);
      if (server.lifecycle === "running" && seen.state === "archived") {
        yield* setServer(
          server.managed_id,
          {
            lifecycle: "stopped",
            last_stopped_at: seen.stoppedAt ?? (yield* nowIso),
          },
          notify,
        );
      } else if (server.lifecycle === "failed" && isLiveState(seen.state)) {
        const latest = yield* latestOperation(managedId);
        if (
          latest?.stage === "failed" &&
          (latest.kind === "create" ||
            latest.kind === "resume" ||
            (latest.kind === "delete" && latest.failure === "unresolved-create"))
        ) {
          yield* cleanupStop(key, server.sandbox_id, server, generation);
        }
      } else if (server.lifecycle === "stopped" && isLiveState(seen.state)) {
        // Restarted outside T3; show it with its new deadline rather than hiding it.
        yield* setServer(server.managed_id, { lifecycle: "running" }, notify);
      }
      if (server.lifecycle === "running" || isLiveState(seen.state)) {
        return yield* updateUsage(key, server.managed_id, server.sandbox_id, notify);
      }
      return true;
    },
    (effect) => effect.pipe(Effect.orElseSucceed(() => false)),
  );

  const reconcile = Effect.gen(function* () {
    const pass = ++reconcilePass;
    const servers = yield* readServers;
    const { key, generation } = yield* readCredentials;
    let changed = false;
    const notify = Effect.sync(() => {
      changed = true;
    });
    const setProviderStale = (stale: boolean) => {
      if (pass === reconcilePass && generation === keyGeneration && stale !== providerStale) {
        providerStale = stale;
        changed = true;
      }
    };
    const publishChanges = Effect.suspend(() => {
      if (!changed) return Effect.void;
      changed = false;
      return publish;
    });
    const checked = yield* checkCredential(key).pipe(Effect.option);
    if (Option.isSome(checked)) {
      yield* recordCredentialStatus(checked.value.status, generation, notify);
      if (checked.value.status !== "configured") {
        setProviderStale(true);
        yield* publishChanges;
        return;
      }
    }
    if (generation !== keyGeneration || Option.isNone(key)) {
      yield* publishChanges;
      return;
    }
    const accountReadFailed = Option.isNone(checked);
    if (accountReadFailed) setProviderStale(true);
    const credential = key.value;
    const pending: string[] = [];
    const settled: string[] = [];
    for (const { managed_id } of servers) {
      ((yield* nextPending(managed_id)) === null ? settled : pending).push(managed_id);
    }
    const [drained, refreshed] = yield* Effect.all(
      [
        Effect.forEach(pending, drain, { concurrency: 4 }),
        Effect.forEach(
          settled,
          (id) => lockFor(id).withPermits(1)(refresh(credential, generation, id, notify)),
          {
            concurrency: 4,
          },
        ).pipe(
          Effect.tap((reads) =>
            Effect.sync(() => {
              if (reads.includes(false)) setProviderStale(true);
            }),
          ),
          Effect.ensuring(publishChanges),
        ),
      ],
      { concurrency: 2 },
    );
    if (accountReadFailed || drained.includes(false) || refreshed.includes(false)) {
      setProviderStale(true);
    } else if (drained.includes(true) || refreshed.includes(true)) {
      setProviderStale(false);
    }
    yield* publishChanges;
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
    forget,
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
