import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { FetchHttpClient } from "effect/http";

import { BoatApi } from "./BoatApi.ts";
import * as BoatHttpApi from "./BoatHttpApi.ts";

const KEY = Redacted.make("boat_test_key");
const SANDBOX_ID = "bx_23456789";

function fakeBoat(reply: (url: URL, init: RequestInit) => Response) {
  const requests: Array<{ readonly url: URL; readonly headers: Headers; readonly method: string }> =
    [];
  const fetch = (async (input: Request | string | URL, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push({ url, headers: new Headers(init.headers), method: init.method ?? "GET" });
    return reply(url, init);
  }) as typeof globalThis.fetch;
  const layer = BoatHttpApi.layer.pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  );
  return { requests, layer };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("BoatHttpApi", () => {
  it.effect("pins the personal wallet and sends the create idempotency key", () => {
    const { requests, layer } = fakeBoat(() =>
      json(
        {
          ok: true,
          sandbox: { id: SANDBOX_ID, state: "provisioning", snapshotAvailable: false },
        },
        202,
      ),
    );
    return Effect.gen(function* () {
      const api = yield* BoatApi;
      yield* api.create(KEY, {
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
        name: "Scratch",
        size: "small",
        ttlSeconds: 3600,
        labels: { "t3.managed": "boat_1" },
      });
      const [request] = requests;
      expect(request?.method).toBe("POST");
      expect(request?.url.pathname).toBe("/api/v1/sandboxes");
      expect(request?.headers.get("x-boat-org")).toBe("personal");
      expect(request?.headers.get("idempotency-key")).toBe("00000000-0000-4000-8000-000000000001");
      expect(request?.headers.get("authorization")).toBe("Bearer boat_test_key");
    }).pipe(Effect.provide(layer));
  });

  it.effect("lets an organization's key act in its own wallet", () => {
    const { requests, layer } = fakeBoat((_url, init) =>
      new Headers(init.headers).get("x-boat-org") === "personal"
        ? json({ ok: false, code: "api_key_org_mismatch", message: "org key" }, 403)
        : json({ ok: true, sandboxes: [], pageInfo: { nextCursor: null, hasMore: false } }),
    );
    return Effect.gen(function* () {
      const api = yield* BoatApi;
      expect(yield* api.list(KEY, { "t3.managed": "boat_1" })).toEqual([]);
      expect(requests.map((request) => request.headers.get("x-boat-org"))).toEqual([
        "personal",
        null,
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("confirms a delete with the sandbox ID and returns the deletion operation", () => {
    const operationId = `bdop_${"a".repeat(32)}`;
    const { requests, layer } = fakeBoat(() =>
      json({ ok: true, operation: { id: operationId, status: "pending" } }, 202),
    );
    return Effect.gen(function* () {
      const api = yield* BoatApi;
      expect(yield* api.delete(KEY, SANDBOX_ID)).toBe(operationId);
      expect(requests[0]?.method).toBe("DELETE");
      expect(requests[0]?.headers.get("x-ascii-confirm-delete")).toBe(SANDBOX_ID);
    }).pipe(Effect.provide(layer));
  });

  it.effect("returns Boat's stop operation ID", () => {
    const { layer } = fakeBoat(() =>
      json({ ok: true, id: SANDBOX_ID, operation: { id: "stop_abc", status: "pending" } }, 202),
    );
    return Effect.gen(function* () {
      const api = yield* BoatApi;
      expect(yield* api.stop(KEY, SANDBOX_ID)).toBe("stop_abc");
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads Boat's one-time cancelled reply and leaves an omitted snapshot unknown", () => {
    const { layer } = fakeBoat(() =>
      json({ ok: true, sandbox: { id: SANDBOX_ID, state: "cancelled", error: "cancelled" } }),
    );
    return Effect.gen(function* () {
      const api = yield* BoatApi;
      const sandbox = yield* api.get(KEY, SANDBOX_ID);
      expect(sandbox.state).toBe("cancelled");
      expect(sandbox.snapshotAvailable).toBeNull();
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps an error status to a safe category without the body", () => {
    const { layer } = fakeBoat(() =>
      json({ ok: false, code: "snapshot_data_expired", message: "secret detail" }, 409),
    );
    return Effect.gen(function* () {
      const api = yield* BoatApi;
      const error = yield* Effect.flip(api.resume(KEY, SANDBOX_ID, 3600));
      expect(error.category).toBe("snapshot-expired");
      expect(JSON.stringify(error)).not.toContain("secret detail");
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses an ID that is not Boat's shape before building a path", () => {
    const { requests, layer } = fakeBoat(() => json({}));
    return Effect.gen(function* () {
      const api = yield* BoatApi;
      const error = yield* Effect.flip(api.get(KEY, "../account"));
      expect(error.code).toBe("invalid_id");
      expect(requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });
});
