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
  const requests: Array<{
    readonly url: URL;
    readonly headers: Headers;
    readonly method: string;
    readonly body: unknown;
  }> = [];
  const fetch = (async (input: Request | string | URL, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push({
      url,
      headers: new Headers(init.headers),
      method: init.method ?? "GET",
      body:
        typeof init.body === "string"
          ? JSON.parse(init.body)
          : init.body instanceof Uint8Array
            ? JSON.parse(new TextDecoder().decode(init.body))
            : undefined,
    });
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
        environment: "t3code",
      });
      const request = requests.at(-1);
      expect(request?.method).toBe("POST");
      expect(request?.url.pathname).toBe("/api/v1/sandboxes");
      expect(request?.headers.get("x-boat-org")).toBe("personal");
      expect(request?.headers.get("idempotency-key")).toBe("00000000-0000-4000-8000-000000000001");
      expect(request?.headers.get("authorization")).toBe("Bearer boat_test_key");
      expect(request?.body).toMatchObject({ environment: "t3code", noEnv: true });
    }).pipe(Effect.provide(layer));
  });

  it.effect("lets an organization's key act in its own wallet", () => {
    const { requests, layer } = fakeBoat((_url, init) =>
      new Headers(init.headers).get("x-boat-org") === "personal"
        ? json({ ok: false, code: "api_key_org_mismatch", message: "org key" }, 403)
        : json({
            ok: true,
            sandboxes: [{ id: SANDBOX_ID, state: "idle" }],
            pageInfo: { nextCursor: null, hasMore: false },
          }),
    );
    return Effect.gen(function* () {
      const api = yield* BoatApi;
      const [sandbox] = yield* api.list(KEY, { "t3.managed": "boat_1" });
      expect(sandbox?.id).toBe(SANDBOX_ID);
      expect(sandbox?.access).toBeUndefined();
      // A probe under the pin, then the real request without it; later calls skip the probe.
      expect(yield* api.list(KEY, { "t3.managed": "boat_2" })).toHaveLength(1);
      expect(requests.map((request) => request.headers.get("x-boat-org"))).toEqual([
        "personal",
        null,
        null,
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("confirms a delete with the sandbox ID and returns the deletion operation", () => {
    const operationId = `bdop_${"a".repeat(32)}`;
    const { requests, layer } = fakeBoat(() =>
      json(
        {
          ok: true,
          operation: { id: operationId, kind: "sandbox", targetId: SANDBOX_ID, status: "pending" },
        },
        202,
      ),
    );
    return Effect.gen(function* () {
      const api = yield* BoatApi;
      expect(yield* api.delete(KEY, SANDBOX_ID)).toBe(operationId);
      expect(requests.at(-1)?.method).toBe("DELETE");
      expect(requests.at(-1)?.headers.get("x-ascii-confirm-delete")).toBe(SANDBOX_ID);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects deletion evidence for a different sandbox", () => {
    const operationId = `bdop_${"a".repeat(32)}`;
    const { layer } = fakeBoat(() =>
      json(
        {
          operation: {
            id: operationId,
            kind: "sandbox",
            targetId: "bx_98765432",
            status: "completed",
          },
        },
        202,
      ),
    );
    return Effect.gen(function* () {
      const api = yield* BoatApi;
      expect((yield* Effect.flip(api.delete(KEY, SANDBOX_ID))).code).toBe("decode");
      expect((yield* Effect.flip(api.deletionCompleted(KEY, operationId, SANDBOX_ID))).code).toBe(
        "decode",
      );
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

  it.effect("accepts a documented stop acknowledgement without an operation", () => {
    const { layer } = fakeBoat(() =>
      json(
        {
          ok: true,
          type: "sandbox.stopping",
          id: SANDBOX_ID,
          status: "archiving",
          sandbox: {
            id: SANDBOX_ID,
            name: "Scratch",
            state: "archiving",
            desktopAvailable: true,
            snapshotAvailable: false,
          },
        },
        202,
      ),
    );
    return Effect.gen(function* () {
      const api = yield* BoatApi;
      expect(yield* api.stop(KEY, SANDBOX_ID)).toBeNull();
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads usage from Boat's top-level documented response", () => {
    const { layer } = fakeBoat(() =>
      json({
        ok: true,
        type: "sandbox.usage",
        sandboxId: SANDBOX_ID,
        sandboxType: "default",
        billingMultiplier: 1,
        since: "2026-09-01T00:00:00.000Z",
        until: "2026-09-14T09:30:00.000Z",
        seconds: 4980,
        dollars: 0.0498,
        secondsPerDollar: 100000,
        running: false,
      }),
    );
    return Effect.gen(function* () {
      const api = yield* BoatApi;
      expect(yield* api.usage(KEY, SANDBOX_ID)).toEqual({
        since: "2026-09-01T00:00:00.000Z",
        until: "2026-09-14T09:30:00.000Z",
        seconds: 4980,
        dollars: 0.0498,
      });
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
      const error = yield* Effect.flip(api.resume(KEY, SANDBOX_ID, 3600, null));
      expect(error.category).toBe("snapshot-expired");
      expect(JSON.stringify(error)).not.toContain("secret detail");
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    { status: 401, code: "unauthenticated", category: "unauthorized" },
    { status: 403, code: "api_key_sandbox_forbidden", category: "forbidden" },
  ])("classifies HTTP $status as $category", ({ status, code, category }) => {
    const { layer } = fakeBoat((url) =>
      url.pathname.endsWith("/me")
        ? json({ user: { id: "usr_1" } })
        : url.pathname.endsWith("/sandboxes")
          ? json({})
          : json({ code }, status),
    );
    return Effect.gen(function* () {
      const api = yield* BoatApi;
      expect((yield* api.account(KEY)).accountId).toBe("usr_1");
      expect(yield* Effect.flip(api.get(KEY, SANDBOX_ID))).toMatchObject({ category, code });
    }).pipe(Effect.provide(layer));
  });

  it.effect("leaves a retention policy /me omits unknown", () => {
    const { layer } = fakeBoat(() => json({ ok: true, user: { id: "usr_1", login: "me" } }));
    return Effect.gen(function* () {
      const api = yield* BoatApi;
      expect((yield* api.account(KEY)).zeroDataRetention).toBeNull();
    }).pipe(Effect.provide(layer));
  });

  it.effect("accepts the documented current user without an account ID", () => {
    const { requests, layer } = fakeBoat((url) =>
      url.pathname.endsWith("/me")
        ? json({
            ok: true,
            type: "user.info",
            user: {
              login: "octocat",
              email: "octocat@example.com",
              zeroDataRetention: false,
              zeroDataRetentionEnabledAt: null,
            },
          })
        : json({ ok: true, type: "sandbox.list", sandboxes: [] }),
    );
    return Effect.gen(function* () {
      const api = yield* BoatApi;
      expect(yield* api.account(KEY)).toEqual({
        accountId: "login:octocat",
        label: "octocat",
        zeroDataRetention: false,
      });
      expect(requests.at(-1)?.url.pathname).toBe("/api/v1/me");
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads the documented sandbox list without pageInfo", () => {
    const { layer } = fakeBoat(() =>
      json({
        ok: true,
        type: "sandbox.list",
        sandboxes: [
          {
            id: SANDBOX_ID,
            name: "Scratch",
            state: "idle",
            desktopAvailable: true,
            snapshotAvailable: false,
            archiveAfter: "2026-05-31T13:00:00Z",
          },
        ],
      }),
    );
    return Effect.gen(function* () {
      const api = yield* BoatApi;
      expect(yield* api.list(KEY, {})).toMatchObject([
        { id: SANDBOX_ID, access: "owner", state: "idle", archiveAfter: "2026-05-31T13:00:00Z" },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects a user response with no usable account identity", () => {
    const { layer } = fakeBoat(() =>
      json({ ok: true, type: "user.info", user: { email: null, zeroDataRetention: false } }),
    );
    return Effect.gen(function* () {
      const api = yield* BoatApi;
      expect(yield* Effect.flip(api.account(KEY))).toMatchObject({ code: "decode" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("follows documented keyset pagination and repeats the allocation filters", () => {
    const { requests, layer } = fakeBoat((url) => {
      if (url.searchParams.get("cursor") === "next-page") {
        return json({
          ok: true,
          type: "sandbox.list",
          sandboxes: [{ id: "bx_98765432", state: "archived" }],
          pageInfo: { nextCursor: null, hasMore: false, limit: 200 },
        });
      }
      return json({
        ok: true,
        type: "sandbox.list",
        sandboxes: [{ id: SANDBOX_ID, state: "idle" }],
        pageInfo: { nextCursor: "next-page", hasMore: true, limit: 200 },
      });
    });
    return Effect.gen(function* () {
      const api = yield* BoatApi;
      const list = yield* api.list(KEY, { "t3.managed": "boat_1" });
      expect(list.map((row) => row.id)).toEqual([SANDBOX_ID, "bx_98765432"]);
      expect(requests.at(-1)?.url.searchParams.getAll("label")).toEqual(["t3.managed=boat_1"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each(["missing", "null cursor", "repeated cursor"] as const)(
    "rejects incomplete inventory with %s pagination",
    (kind) => {
      const { layer } = fakeBoat(() =>
        json(
          kind === "missing"
            ? { sandboxes: Array.from({ length: 200 }, () => ({ id: SANDBOX_ID, state: "idle" })) }
            : {
                sandboxes: [],
                pageInfo: { hasMore: true, nextCursor: kind === "null cursor" ? null : "same" },
              },
        ),
      );
      return Effect.gen(function* () {
        const api = yield* BoatApi;
        expect(yield* Effect.flip(api.list(KEY, {}))).toMatchObject({ code: "decode" });
      }).pipe(Effect.provide(layer));
    },
  );

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
