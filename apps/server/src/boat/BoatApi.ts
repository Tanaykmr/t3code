// The environment-provider driver for Boat. Callers pass a resolved key and an immutable resource
// or operation ID; lifecycle policy stays in BoatService.
import type { BoatMachineSize, EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export const BoatApiErrorCategory = Schema.Literals([
  "unauthorized",
  "not-found",
  /** Idempotency key still in flight, a stop in progress, or a state conflict. */
  "conflict",
  "rate-limited",
  "quota-exceeded",
  "snapshot-expired",
  "unavailable",
  "rejected",
]);
export type BoatApiErrorCategory = typeof BoatApiErrorCategory.Type;

/** Carries a safe category and Boat's error code only, never a body or header. */
export class BoatApiError extends Schema.TaggedError<BoatApiError>()("BoatApiError", {
  category: BoatApiErrorCategory,
  code: Schema.optional(Schema.String),
}) {}

export const BoatSandboxState = Schema.Literals([
  "init",
  "provisioning",
  "provisioned",
  "cloning",
  "ready",
  "idle",
  "running",
  "archiving",
  "archived",
  "error",
  "cancelled",
]);
export type BoatSandboxState = typeof BoatSandboxState.Type;

export interface BoatSandbox {
  readonly id: string;
  readonly state: BoatSandboxState;
  readonly labels: Readonly<Record<string, string>>;
  readonly archiveAfter: string | null;
  readonly stoppedAt: string | null;
  readonly dataExpiredAt: string | null;
  /** Null when Boat's reply left it out, which says nothing about the disk. */
  readonly snapshotAvailable: boolean | null;
}

export interface BoatAccount {
  readonly accountId: string;
  readonly label: string;
  readonly zeroDataRetention: boolean;
}

export interface BoatUsage {
  readonly seconds: number;
  readonly dollars: number;
  readonly since: string;
  readonly until: string;
}

export interface BoatCreateRequest {
  /** The durable create request ID, sent as Boat's `Idempotency-Key`. */
  readonly idempotencyKey: string;
  readonly name: string;
  readonly size: BoatMachineSize;
  readonly ttlSeconds: number;
  readonly labels: Readonly<Record<string, string>>;
}

export type BoatKey = Redacted.Redacted<string>;

export class BoatApi extends Context.Service<
  BoatApi,
  {
    readonly account: (key: BoatKey) => Effect.Effect<BoatAccount, BoatApiError>;
    readonly create: (
      key: BoatKey,
      request: BoatCreateRequest,
    ) => Effect.Effect<BoatSandbox, BoatApiError>;
    readonly get: (key: BoatKey, sandboxId: string) => Effect.Effect<BoatSandbox, BoatApiError>;
    /** Every page, filtered by all of `labels`. */
    readonly list: (
      key: BoatKey,
      labels: Readonly<Record<string, string>>,
    ) => Effect.Effect<ReadonlyArray<BoatSandbox>, BoatApiError>;
    /** Graceful stop; Boat coalesces repeats. */
    readonly stop: (key: BoatKey, sandboxId: string) => Effect.Effect<void, BoatApiError>;
    readonly resume: (
      key: BoatKey,
      sandboxId: string,
      ttlSeconds: number,
    ) => Effect.Effect<void, BoatApiError>;
    /** Returns the deletion operation ID to poll. */
    readonly delete: (key: BoatKey, sandboxId: string) => Effect.Effect<string, BoatApiError>;
    readonly deletionCompleted: (
      key: BoatKey,
      operationId: string,
    ) => Effect.Effect<boolean, BoatApiError>;
    readonly usage: (key: BoatKey, sandboxId: string) => Effect.Effect<BoatUsage, BoatApiError>;
  }
>()("t3/boat/BoatApi") {}

export class BoatBootstrapError extends Schema.TaggedError<BoatBootstrapError>()(
  "BoatBootstrapError",
  { reason: Schema.Literals(["unavailable", "identity-mismatch", "failed"]) },
) {}

export interface BoatGuest {
  readonly environmentId: EnvironmentId;
  readonly origin: string;
}

/**
 * Installs or verifies T3 on an owned sandbox through fixed operations and returns the guest's
 * own identity. With `expected`, a guest that answers with another ID is a mismatch.
 */
export class BoatGuestBootstrap extends Context.Service<
  BoatGuestBootstrap,
  {
    /** False until guest installation is proven on a live Boat; Create and Resume wait for it. */
    readonly available: boolean;
    readonly ensure: (input: {
      readonly key: BoatKey;
      readonly sandboxId: string;
      readonly expected: EnvironmentId | null;
    }) => Effect.Effect<BoatGuest, BoatBootstrapError | BoatApiError>;
  }
>()("t3/boat/BoatApi/BoatGuestBootstrap") {}

export const isLiveState = (state: BoatSandboxState) =>
  state === "ready" || state === "idle" || state === "running";
