// Boat REST v1 (https://docs.boat.dev/api/v1). Decodes only the fields the lifecycle reads and
// maps failures to safe categories; response bodies never reach logs or errors.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  BoatApi,
  BoatApiError,
  type BoatApiErrorCategory,
  BoatBootstrapError,
  BoatGuestBootstrap,
  type BoatKey,
  type BoatSandbox,
  BoatSandboxState,
} from "./BoatApi.ts";

const BASE_URL = "https://boat.dev/api/v1";
const MANUAL_REDIRECT: RequestInit = { redirect: "manual" };

const SandboxBody = Schema.Struct({
  id: Schema.String,
  state: BoatSandboxState,
  labels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  archiveAfter: Schema.optional(Schema.NullOr(Schema.String)),
  stoppedAt: Schema.optional(Schema.NullOr(Schema.String)),
  dataExpiredAt: Schema.optional(Schema.NullOr(Schema.String)),
  // Boat reports a cancelled sandbox once with only id, state and error.
  snapshotAvailable: Schema.optional(Schema.Boolean),
  stop: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.optional(Schema.String),
        status: Schema.Literals(["pending", "failing", "completed", "superseded"]),
      }),
    ),
  ),
});
const SandboxEnvelope = Schema.Struct({ sandbox: SandboxBody });
const ListEnvelope = Schema.Struct({
  sandboxes: Schema.Array(SandboxBody),
  pageInfo: Schema.Struct({ nextCursor: Schema.NullOr(Schema.String), hasMore: Schema.Boolean }),
});
const UserEnvelope = Schema.Struct({
  user: Schema.Struct({
    id: Schema.String,
    login: Schema.optional(Schema.String),
    displayName: Schema.optional(Schema.String),
    zeroDataRetention: Schema.optional(Schema.Boolean),
  }),
});
const DeletionEnvelope = Schema.Struct({
  operation: Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("sandbox"),
    targetId: Schema.String,
    status: Schema.Literals(["pending", "processing", "blocked", "completed"]),
  }),
});
const StopEnvelope = Schema.Struct({
  operation: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.String }))),
});
const UsageEnvelope = Schema.Struct({
  seconds: Schema.Number,
  dollars: Schema.Number,
  since: Schema.String,
  until: Schema.String,
});
const ErrorEnvelope = Schema.Struct({ code: Schema.optional(Schema.String) });

const toSandbox = (body: typeof SandboxBody.Type): BoatSandbox => ({
  id: body.id,
  state: body.state,
  labels: body.labels ?? {},
  archiveAfter: body.archiveAfter ?? null,
  stoppedAt: body.stoppedAt ?? null,
  dataExpiredAt: body.dataExpiredAt ?? null,
  snapshotAvailable: body.snapshotAvailable ?? null,
  stopId: body.stop?.id ?? null,
  stopStatus: body.stop?.status ?? null,
});

function categoryFor(status: number, code: string | undefined): BoatApiErrorCategory {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 402) return "quota-exceeded";
  if (status === 409 && code === "snapshot_data_expired") return "snapshot-expired";
  if (status === 409) return "conflict";
  if (status === 429) return code === "limit_reached" ? "quota-exceeded" : "rate-limited";
  if (status >= 500) return "unavailable";
  return "rejected";
}

const SANDBOX_ID = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
const DELETION_ID = /^bdop_[a-f0-9]{32}$/;

// IDs are interpolated into paths, so only Boat's documented shapes pass.
const checked = Effect.fn("BoatHttpApi.checkId")(function* (pattern: RegExp, id: string) {
  if (!pattern.test(id))
    return yield* new BoatApiError({ category: "rejected", code: "invalid_id" });
  return id;
});

const decode =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  (body: unknown) =>
    Schema.decodeUnknownEffect(schema)(body).pipe(
      Effect.mapError(() => new BoatApiError({ category: "rejected", code: "decode" })),
    );

const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;

  /** The JSON body of a 2xx reply; anything else becomes a categorized error. */
  const sendOnce = Effect.fn("BoatHttpApi.sendOnce")(function* (
    key: BoatKey,
    request: HttpClientRequest.HttpClientRequest,
    pinPersonal: boolean,
  ) {
    const response = yield* client
      .execute(
        request.pipe(
          HttpClientRequest.prependUrl(BASE_URL),
          HttpClientRequest.setHeader("Authorization", `Bearer ${Redacted.value(key)}`),
          // Pin the personal wallet so a changed default org cannot bill or hide a machine.
          pinPersonal ? HttpClientRequest.setHeader("X-Boat-Org", "personal") : (r) => r,
          HttpClientRequest.acceptJson,
        ),
      )
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECT),
        Effect.mapError(() => new BoatApiError({ category: "unavailable" })),
      );
    if (response.status >= 200 && response.status < 300) {
      return yield* response.json.pipe(
        Effect.mapError(() => new BoatApiError({ category: "rejected", code: "decode" })),
      );
    }
    const code = yield* HttpClientResponse.schemaBodyJson(ErrorEnvelope)(response).pipe(
      Effect.map((body) => body.code),
      Effect.orElseSucceed(() => undefined),
    );
    return yield* new BoatApiError({ category: categoryFor(response.status, code), code });
  }, Effect.scoped);

  // A key created for an organization can act only in that organization, which already pins
  // its wallet, and Boat refuses it under the personal pin (in any environment it names). Whether
  // a key is such a key is learned once with a harmless list read under the pin.
  const orgBound = new Map<string, boolean>();
  const isOrgBound = Effect.fn("BoatHttpApi.isOrgBound")(function* (key: BoatKey) {
    const known = orgBound.get(Redacted.value(key));
    if (known !== undefined) return known;
    const bound = yield* sendOnce(key, HttpClientRequest.get("/sandboxes?limit=1"), true).pipe(
      Effect.as(false),
      Effect.catchIf(
        (error) => error.code === "api_key_org_mismatch",
        () => Effect.succeed(true),
      ),
    );
    orgBound.set(Redacted.value(key), bound);
    return bound;
  });

  /** The JSON body of a 2xx reply; anything else becomes a categorized error. */
  const send = Effect.fn("BoatHttpApi.send")(function* (
    key: BoatKey,
    request: HttpClientRequest.HttpClientRequest,
  ) {
    return yield* sendOnce(key, request, !(yield* isOrgBound(key)));
  });

  return BoatApi.of({
    account: Effect.fn("BoatHttpApi.account")(function* (key) {
      const { user } = yield* send(key, HttpClientRequest.get("/me")).pipe(
        Effect.flatMap(decode(UserEnvelope)),
      );
      return {
        accountId: user.id,
        label: user.displayName ?? user.login ?? user.id,
        zeroDataRetention: user.zeroDataRetention ?? null,
      };
    }),
    create: Effect.fn("BoatHttpApi.create")(function* (key, request) {
      const { sandbox } = yield* send(
        key,
        HttpClientRequest.post("/sandboxes").pipe(
          HttpClientRequest.setHeader("Idempotency-Key", request.idempotencyKey),
          HttpClientRequest.bodyJsonUnsafe({
            type: request.size,
            ttlSeconds: request.ttlSeconds,
            labels: request.labels,
            name: request.name,
            ...(request.environment === null ? {} : { environment: request.environment }),
            noEnv: true,
            snapshots: true,
          }),
        ),
      ).pipe(Effect.flatMap(decode(SandboxEnvelope)));
      return toSandbox(sandbox);
    }),
    get: Effect.fn("BoatHttpApi.get")(function* (key, sandboxId) {
      const id = yield* checked(SANDBOX_ID, sandboxId);
      const { sandbox } = yield* send(key, HttpClientRequest.get(`/sandboxes/${id}`)).pipe(
        Effect.flatMap(decode(SandboxEnvelope)),
      );
      return toSandbox(sandbox);
    }),
    list: Effect.fn("BoatHttpApi.list")(function* (key, labels) {
      const sandboxes: Array<BoatSandbox> = [];
      let cursor: string | null = null;
      for (;;) {
        const params: Array<[string, string]> = [
          ["limit", "200"],
          ...Object.entries(labels).map(([name, value]): [string, string] => [
            "label",
            `${name}=${value}`,
          ]),
          ...(cursor === null ? [] : [["cursor", cursor] as [string, string]]),
        ];
        const page: typeof ListEnvelope.Type = yield* send(
          key,
          HttpClientRequest.get("/sandboxes").pipe(HttpClientRequest.setUrlParams(params)),
        ).pipe(Effect.flatMap(decode(ListEnvelope)));
        sandboxes.push(...page.sandboxes.map(toSandbox));
        if (!page.pageInfo.hasMore || page.pageInfo.nextCursor === null) return sandboxes;
        cursor = page.pageInfo.nextCursor;
      }
    }),
    stop: Effect.fn("BoatHttpApi.stop")(function* (key, sandboxId) {
      const id = yield* checked(SANDBOX_ID, sandboxId);
      const { operation } = yield* send(
        key,
        HttpClientRequest.post(`/sandboxes/${id}/stop`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ force: false }),
        ),
      ).pipe(Effect.flatMap(decode(StopEnvelope)));
      return operation?.id ?? null;
    }),
    resume: Effect.fn("BoatHttpApi.resume")(function* (key, sandboxId, ttlSeconds, environment) {
      const id = yield* checked(SANDBOX_ID, sandboxId);
      yield* send(
        key,
        HttpClientRequest.post(`/sandboxes/${id}/resume`).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            ttlSeconds,
            ...(environment === null ? {} : { environment }),
            noEnv: true,
          }),
        ),
      );
    }),
    delete: Effect.fn("BoatHttpApi.delete")(function* (key, sandboxId) {
      const id = yield* checked(SANDBOX_ID, sandboxId);
      const { operation } = yield* send(
        key,
        HttpClientRequest.delete(`/sandboxes/${id}`).pipe(
          HttpClientRequest.setHeader("X-Ascii-Confirm-Delete", id),
        ),
      ).pipe(Effect.flatMap(decode(DeletionEnvelope)));
      if (operation.targetId !== id) {
        return yield* new BoatApiError({ category: "rejected", code: "decode" });
      }
      return yield* checked(DELETION_ID, operation.id);
    }),
    deletionCompleted: Effect.fn("BoatHttpApi.deletionCompleted")(
      function* (key, operationId, sandboxId) {
        const id = yield* checked(DELETION_ID, operationId);
        const { operation } = yield* send(
          key,
          HttpClientRequest.get(`/deletion-operations/${id}`),
        ).pipe(Effect.flatMap(decode(DeletionEnvelope)));
        if (operation.id !== id || operation.targetId !== sandboxId) {
          return yield* new BoatApiError({ category: "rejected", code: "decode" });
        }
        return operation.status === "completed";
      },
    ),
    usage: Effect.fn("BoatHttpApi.usage")(function* (key, sandboxId) {
      const id = yield* checked(SANDBOX_ID, sandboxId);
      return yield* send(key, HttpClientRequest.get(`/sandboxes/${id}/usage`)).pipe(
        Effect.flatMap(decode(UsageEnvelope)),
      );
    }),
  });
});

export const layer = Layer.effect(BoatApi, make);

/**
 * Guest installation needs a pinned trusted T3 artifact and a sealed pairing channel, which are
 * proven against a live Boat (docs/architecture/boat.md, Stage 2). Until then every bootstrap
 * fails safely, and the lifecycle asks Boat to stop the machine.
 */
export const layerBootstrapUnavailable = Layer.succeed(
  BoatGuestBootstrap,
  BoatGuestBootstrap.of({
    available: false,
    ensure: Effect.fn("BoatGuestBootstrap.unavailable")(function* () {
      return yield* new BoatBootstrapError({ reason: "unavailable" });
    }),
  }),
);
