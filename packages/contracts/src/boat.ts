import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  ForwardCompatibleArray,
  ForwardCompatibleNullable,
  IsoDateTime,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** Controller-assigned; exists before the guest and its environment ID do. */
export const BoatManagedId = TrimmedNonEmptyString.pipe(Schema.brand("BoatManagedId"));
export type BoatManagedId = typeof BoatManagedId.Type;

/** Client-generated UUID; a repeated request returns the operation it first started. */
export const BoatRequestId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
).pipe(Schema.brand("BoatRequestId"));
export type BoatRequestId = typeof BoatRequestId.Type;

export const BoatMachineSize = Schema.Literals(["small", "default"]);
export type BoatMachineSize = typeof BoatMachineSize.Type;

const BOAT_MIN_TTL_SECONDS = 15 * 60;
const BOAT_MAX_TTL_SECONDS = 24 * 60 * 60;

export const BoatTtlSeconds = Schema.Int.check(
  Schema.isBetween({ minimum: BOAT_MIN_TTL_SECONDS, maximum: BOAT_MAX_TTL_SECONDS }),
);

export const BoatLifecycle = Schema.Literals([
  "provisioning",
  "running",
  "stopping",
  "stopped",
  "failed",
  "deleting",
]);
export type BoatLifecycle = typeof BoatLifecycle.Type;

export const BoatOperationKind = Schema.Literals(["create", "stop", "resume", "delete"]);
export type BoatOperationKind = typeof BoatOperationKind.Type;

export const BoatOperationStage = Schema.Literals([
  "queued",
  "allocating",
  "bootstrapping",
  "stopping",
  "resuming",
  "deleting",
  "completed",
  "failed",
]);
export type BoatOperationStage = typeof BoatOperationStage.Type;

/** Safe categories only; provider bodies and command output never travel. */
export const BoatFailureCode = Schema.Literals([
  "unauthorized",
  "quota-exceeded",
  "provider-unavailable",
  "provider-rejected",
  "bootstrap-failed",
  "snapshot-expired",
  "not-found",
  "unresolved-create",
  /** Delete refused: Boat still reports the machine running. */
  "machine-running",
  /** Refused before reaching Boat: this server cannot install T3 on a machine. */
  "bootstrap-unavailable",
]);
export type BoatFailureCode = typeof BoatFailureCode.Type;

export const BoatOperation = Schema.Struct({
  kind: BoatOperationKind,
  requestId: BoatRequestId,
  stage: BoatOperationStage,
  /** A newer server's reason this client does not know reads as null, keeping the row. */
  failure: ForwardCompatibleNullable(BoatFailureCode),
  updatedAt: IsoDateTime,
});
export type BoatOperation = typeof BoatOperation.Type;

export const BoatObservedPower = Schema.Literals(["running", "stopping", "stopped", "missing"]);
export type BoatObservedPower = typeof BoatObservedPower.Type;

export const BoatRetention = Schema.Literals(["available", "expired", "unknown"]);
export type BoatRetention = typeof BoatRetention.Type;

export const BoatUsageSample = Schema.Struct({
  /** Size-weighted machine seconds as Boat reports them. */
  machineSeconds: Schema.Number,
  listPriceUsd: Schema.Number,
  windowStart: IsoDateTime,
  windowEnd: IsoDateTime,
  observedAt: IsoDateTime,
});
export type BoatUsageSample = typeof BoatUsageSample.Type;

export const BoatServer = Schema.Struct({
  managedId: BoatManagedId,
  displayName: TrimmedNonEmptyString,
  size: BoatMachineSize,
  ttlSeconds: Schema.Int,
  lifecycle: BoatLifecycle,
  /** The latest operation, kept after it settles so a failure stays visible. */
  operation: Schema.NullOr(BoatOperation),
  sandboxId: Schema.NullOr(TrimmedNonEmptyString),
  /** Set only after the guest's own descriptor was verified. */
  guestEnvironmentId: Schema.NullOr(EnvironmentId),
  /** Credential-free HTTPS origin of the guest, once verified. */
  origin: Schema.NullOr(TrimmedNonEmptyString),
  observedPower: Schema.NullOr(BoatObservedPower),
  observedAt: Schema.NullOr(IsoDateTime),
  /** Boat's own auto-stop deadline for the current run. */
  autoStopAt: Schema.NullOr(IsoDateTime),
  retention: BoatRetention,
  usage: Schema.NullOr(BoatUsageSample),
  createdAt: IsoDateTime,
  lastStartedAt: Schema.NullOr(IsoDateTime),
  lastStoppedAt: Schema.NullOr(IsoDateTime),
});
export type BoatServer = typeof BoatServer.Type;

export const BoatAccountStatus = Schema.Literals(["missing", "configured", "invalid"]);
export type BoatAccountStatus = typeof BoatAccountStatus.Type;

export const BoatRate = Schema.Struct({
  size: BoatMachineSize,
  usdPerHour: Schema.Number,
  asOf: IsoDateTime,
});
export type BoatRate = typeof BoatRate.Type;

export const BoatSnapshot = Schema.Struct({
  /** Never the key itself; only whether one is stored and whether Boat accepted it. */
  account: Schema.Struct({
    status: BoatAccountStatus,
    label: Schema.NullOr(TrimmedNonEmptyString),
    /** The Boat environment new machines go to; absent means Boat's default. */
    environment: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  rates: ForwardCompatibleArray(BoatRate),
  servers: ForwardCompatibleArray(BoatServer),
  /** False while this server cannot install T3 on a new machine; Create and Resume are refused. */
  createAvailable: Schema.optionalKey(Schema.Boolean),
  forgetAvailable: Schema.optionalKey(Schema.Boolean),
  /** Provider observations were incomplete on the last reconciliation, independent of the socket. */
  providerStale: Schema.optionalKey(Schema.Boolean),
});
export type BoatSnapshot = typeof BoatSnapshot.Type;

export const BoatSubscribeInput = Schema.Struct({});
export type BoatSubscribeInput = typeof BoatSubscribeInput.Type;

export const BoatCreateInput = Schema.Struct({
  requestId: BoatRequestId,
  displayName: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  size: BoatMachineSize,
  ttlSeconds: BoatTtlSeconds,
});
export type BoatCreateInput = typeof BoatCreateInput.Type;

export const BoatLifecycleInput = Schema.Struct({
  requestId: BoatRequestId,
  managedId: BoatManagedId,
});
export type BoatLifecycleInput = typeof BoatLifecycleInput.Type;

export const BoatForgetInput = Schema.Struct({
  managedId: BoatManagedId,
  confirmed: Schema.Literal(true),
});
export type BoatForgetInput = typeof BoatForgetInput.Type;

export const BoatOperationReceipt = Schema.Struct({
  managedId: BoatManagedId,
  requestId: BoatRequestId,
  kind: BoatOperationKind,
});
export type BoatOperationReceipt = typeof BoatOperationReceipt.Type;

/** Null removes the stored key. The key is write-only: no read returns it. */
export const BoatSetApiKeyInput = Schema.Struct({
  apiKey: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  /**
   * The Boat environment new machines are created in; a scoped key may allow only its own.
   * Omitted keeps the current one and null clears it.
   */
  environment: Schema.optionalKey(
    Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  ),
});
export type BoatSetApiKeyInput = typeof BoatSetApiKeyInput.Type;

export const BoatSetApiKeyResult = Schema.Struct({ status: BoatAccountStatus });
export type BoatSetApiKeyResult = typeof BoatSetApiKeyResult.Type;

export const BoatErrorCode = Schema.Literals([
  "not-configured",
  "not-found",
  /** The request ID was already used with different inputs. */
  "conflict",
  /** The record's state does not allow this action. */
  "invalid-state",
  "provider-unavailable",
  "unauthorized",
  "persistence",
  /** The key write arrived over plain HTTP from another machine. */
  "insecure-transport",
]);
export type BoatErrorCode = typeof BoatErrorCode.Type;

export class BoatError extends Schema.TaggedError<BoatError>()("BoatError", {
  code: BoatErrorCode,
  message: Schema.String,
}) {}

/** The actions a record's state allows; clients and the server read the same rules. */
export function boatAllowedActions(
  server: Pick<BoatServer, "lifecycle" | "sandboxId" | "retention" | "operation">,
): ReadonlySet<Exclude<BoatOperationKind, "create">> {
  const actions = new Set<Exclude<BoatOperationKind, "create">>();
  switch (server.lifecycle) {
    case "provisioning":
    case "running":
      actions.add("stop");
      break;
    case "stopped":
      if (server.retention !== "expired") actions.add("resume");
      actions.add("delete");
      break;
    case "failed":
      if (server.sandboxId !== null) actions.add("stop");
      actions.add("delete");
      break;
    case "stopping":
    case "deleting":
      break;
  }
  return actions;
}
