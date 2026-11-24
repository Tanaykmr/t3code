import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { type BoardElement, EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { McpSchema, McpServer, type Tool } from "effect/ai";

import * as BoardService from "../../../board/BoardService.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as BoardHandlers from "./handlers.ts";
import { BoardToolkit } from "./tools.ts";

const DRAWING_THREAD = ThreadId.make("thread-drawing");
const OTHER_THREAD = ThreadId.make("thread-other");
const PLAN_THREAD = ThreadId.make("thread-plan");

const threadCaller = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: `session-${threadId}`,
  thread: {
    threadId,
    providerSessionId: `session-${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(),
  issuedAt: 1,
});

const outsideClient: McpInvocationContext.McpInvocationScope = {
  ...threadCaller(DRAWING_THREAD),
  thread: undefined,
  client: { sessionId: "client-1", label: "CLI", access: "full-access" },
};

const layerDependencies = Layer.mergeAll(
  BoardService.layer,
  Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (threadId) =>
      Effect.succeed(
        liveThreadShell(threadId, {
          interactionMode: threadId === PLAN_THREAD ? "plan" : "default",
        }),
      ),
  }),
).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(
    Layer.succeed(ProjectionStore.ProjectionStoreV2, {
      getThreadTitles: (ids: ReadonlyArray<ThreadId>) =>
        Effect.succeed(Object.fromEntries(ids.map((id) => [id, "Thread"]))),
    } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
  ),
  Layer.provideMerge(SecureRandom.layerWebCrypto),
);

const layer = it.layer(layerDependencies);

const callAs = <Name extends keyof typeof BoardToolkit.tools>(
  scope: McpInvocationContext.McpInvocationScope,
  name: Name,
  params: Tool.Parameters<(typeof BoardToolkit.tools)[Name]>,
) =>
  Effect.gen(function* () {
    const toolkit = yield* BoardToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(BoardHandlers.layer)),
    );
    const last = yield* toolkit.handle(name, params as never).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunk) => chunk.at(-1)!),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    );
    // The tools return failures, as the MCP server sends them; tests flip them back.
    if (last.isFailure)
      return yield* last.result as Tool.Failure<(typeof BoardToolkit.tools)[Name]>;
    return last.result as Tool.Success<(typeof BoardToolkit.tools)[Name]>;
  });

const call = <Name extends keyof typeof BoardToolkit.tools>(
  name: Name,
  params: Tool.Parameters<(typeof BoardToolkit.tools)[Name]>,
) => callAs(threadCaller(DRAWING_THREAD), name, params);

const storedElements = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const boards = yield* BoardService.BoardService;
    const snapshot = yield* boards.get(threadId);
    assert(snapshot !== null);
    return new Map(snapshot.elements.map((element) => [element.id, element]));
  });

const boundIds = (element: BoardElement | undefined, type: string) =>
  ((element?.boundElements ?? []) as ReadonlyArray<{ id: string; type: string }>)
    .filter((ref) => ref.type === type)
    .map((ref) => ref.id)
    .toSorted();

const box = (id: string, x: number, label: string) =>
  ({ op: "create", type: "rectangle", id, x, y: 0, width: 100, height: 60, label }) as const;

const token = (element: { readonly version: number; readonly versionNonce: number }) => ({
  version: element.version,
  versionNonce: element.versionNonce,
});

/** An edit from the user's editor, which bumps only the records it changes. */
const userEdit = (threadId: ThreadId, id: string, changes: Record<string, unknown>) =>
  Effect.gen(function* () {
    const boards = yield* BoardService.BoardService;
    const snapshot = yield* boards.get(threadId);
    assert(snapshot !== null);
    const element = snapshot.elements.find((candidate) => candidate.id === id)!;
    yield* boards.apply({
      actor: "user",
      batch: {
        threadId,
        boardId: snapshot.board.boardId,
        mutationId: `user-${snapshot.board.revision}`,
        operations: [
          { type: "replace", element: { ...element, ...changes }, expected: token(element) },
        ],
      },
    });
  });

layer("board toolkit", (it) => {
  describe("drawing a connected diagram", () => {
    it.effect("stores labels and arrow bindings both ways, and reads them back", () =>
      Effect.gen(function* () {
        expect(yield* call("board_get", {})).toEqual({
          boardId: null,
          revision: 0,
          total: 0,
          elements: [],
        });
        const created = yield* call("board_create", {});
        expect(created.revision).toBe(0);

        const applied = yield* call("board_apply", {
          edits: [
            box("api", 0, "API"),
            box("db", 300, "Database"),
            box("cache", 600, "Cache"),
            { op: "create", type: "arrow", id: "reads", start: "api", end: "db", label: "reads" },
            { op: "create", type: "arrow", start: "db", end: "cache" },
          ],
        });
        expect(applied.revision).toBe(1);
        expect(Object.keys(applied.ids).toSorted()).toEqual(["api", "cache", "db", "reads"]);
        // Two arrows beyond the named ones; labels are edited through their container.
        expect(applied.elements).toHaveLength(5);

        const stored = yield* storedElements(DRAWING_THREAD);
        const api = stored.get(applied.ids.api!)!;
        const db = stored.get(applied.ids.db!)!;
        const cache = stored.get(applied.ids.cache!)!;
        const reads = stored.get(applied.ids.reads!)!;
        const [arrowIntoCache] = boundIds(cache, "arrow");
        const toCache = stored.get(arrowIntoCache!)!;

        for (const [shape, label] of [
          [api, "API"],
          [db, "Database"],
          [cache, "Cache"],
          [reads, "reads"],
        ] as const) {
          const [labelId] = boundIds(shape, "text");
          expect(stored.get(labelId!)).toMatchObject({
            type: "text",
            containerId: shape.id,
            originalText: label,
            textAlign: "center",
            verticalAlign: "middle",
          });
        }
        expect(reads).toMatchObject({
          startBinding: { elementId: api.id, focus: 0, gap: 5 },
          endBinding: { elementId: db.id, focus: 0, gap: 5 },
          endArrowhead: "arrow",
        });
        expect(toCache).toMatchObject({
          startBinding: { elementId: db.id },
          endBinding: { elementId: cache.id },
        });
        expect(boundIds(api, "arrow")).toEqual([reads.id]);
        expect(boundIds(db, "arrow")).toEqual([reads.id, toCache.id].toSorted());
        // The arrow runs between the two boxes' facing edges, the binding gap outside each.
        expect(reads).toMatchObject({ x: 105, y: 30, width: 190, height: 0 });

        const summary = yield* call("board_get", {});
        expect(summary.total).toBe(5);
        expect(summary.elements.map((element) => element.label ?? element.type)).toEqual([
          "API",
          "Database",
          "Cache",
          "reads",
          "arrow",
        ]);
        expect(summary.elements[3]).toEqual({
          id: reads.id,
          type: "arrow",
          x: 105,
          y: 30,
          width: 190,
          height: 0,
          version: reads.version,
          versionNonce: reads.versionNonce,
          label: "reads",
          start: api.id,
          end: db.id,
        });
        const found = yield* call("board_get", { text: "datab" });
        expect(found.elements.map((element) => element.id)).toEqual([db.id]);
        const firstPage = yield* call("board_get", { limit: 2 });
        expect(firstPage.nextCursor).toMatch(/^1:2:/);
        const secondPage = yield* call("board_get", { limit: 2, cursor: firstPage.nextCursor! });
        expect(secondPage.elements.map((element) => element.id)).toEqual([cache.id, reads.id]);
        expect(
          yield* call("board_get", { text: "a", cursor: firstPage.nextCursor! }).pipe(Effect.flip),
          "a cursor only continues the read it came from",
        ).toMatchObject({ code: "invalid_request", message: expect.stringContaining("cursor") });
      }),
    );

    it.effect("moves a shape's label and arrows with it, and rejects a stale token", () =>
      Effect.gen(function* () {
        const { elements: board, revision } = yield* call("board_get", {});
        const cache = board.find((element) => element.label === "Cache")!;
        const stale = { version: cache.version - 1, versionNonce: cache.versionNonce };

        const conflict = yield* call("board_apply", {
          revision,
          edits: [{ op: "patch", id: cache.id, expected: stale, y: 300 }],
        }).pipe(Effect.flip);
        expect(conflict).toMatchObject({
          _tag: "BoardEditConflictError",
          conflicts: [
            { id: cache.id, current: { version: cache.version, versionNonce: cache.versionNonce } },
          ],
        });
        expect((yield* call("board_get", {})).revision).toBe(1);

        const moved = yield* call("board_apply", {
          revision,
          edits: [
            {
              op: "patch",
              id: cache.id,
              expected: { version: cache.version, versionNonce: cache.versionNonce },
              y: 300,
            },
          ],
        });
        const stored = yield* storedElements(DRAWING_THREAD);
        const [labelId] = boundIds(stored.get(cache.id), "text");
        const [arrowId] = boundIds(stored.get(cache.id), "arrow");
        // Label stays centred in the 100×60 box now at y 300.
        expect(stored.get(labelId!)).toMatchObject({ y: 330 - 12.5 });
        const arrow = stored.get(arrowId!)!;
        const points = arrow.points as ReadonlyArray<readonly [number, number]>;
        const endY = (arrow.y as number) + points.at(-1)![1];
        expect(endY).toBeGreaterThan(290);
        expect(endY).toBeLessThan(300);
        expect(moved.elements.map((element) => element.id).toSorted()).toEqual(
          [cache.id, arrowId!].toSorted(),
        );
      }),
    );

    it.effect("deletes a shape with its label and lets go of its arrows", () =>
      Effect.gen(function* () {
        const { elements: board, revision } = yield* call("board_get", {});
        const api = board.find((element) => element.label === "API")!;
        const reads = board.find((element) => element.label === "reads")!;
        yield* call("board_apply", {
          revision,
          edits: [
            {
              op: "delete",
              id: api.id,
              expected: { version: api.version, versionNonce: api.versionNonce },
            },
          ],
        });
        const after = yield* call("board_get", {});
        expect(after.elements.map((element) => element.id)).not.toContain(api.id);
        expect(after.elements.find((element) => element.id === reads.id)).not.toHaveProperty(
          "start",
        );
        const stored = yield* storedElements(DRAWING_THREAD);
        const [apiLabel] = boundIds(stored.get(api.id), "text");
        expect(stored.get(apiLabel!)?.isDeleted).toBe(true);
      }),
    );
  });

  it.effect("refuses a patch or delete that would overwrite a label the user changed", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-dependents");
      const as = threadCaller(threadId);
      yield* callAs(as, "board_create", {});
      yield* callAs(as, "board_apply", {
        edits: [
          box("api", 0, "API"),
          box("db", 300, "DB"),
          { op: "create", type: "arrow", start: "api", end: "db" },
        ],
      });
      const read = yield* callAs(as, "board_get", {});
      const api = read.elements.find((element) => element.label === "API")!;
      const db = read.elements.find((element) => element.label === "DB")!;
      const [labelId] = boundIds((yield* storedElements(threadId)).get(api.id), "text");
      yield* userEdit(threadId, labelId!, { text: "Gateway", originalText: "Gateway" });
      expect(
        (yield* callAs(as, "board_get", { ids: [api.id] })).elements[0],
        "only the label's token moved",
      ).toMatchObject({ ...token(api), label: "Gateway" });

      for (const edit of [
        { op: "patch", id: api.id, expected: token(api), label: "Edge" },
        { op: "patch", id: api.id, expected: token(api), x: 40 },
        { op: "delete", id: api.id, expected: token(api) },
      ] as const) {
        expect(
          yield* callAs(as, "board_apply", { revision: read.revision, edits: [edit] }).pipe(
            Effect.flip,
          ),
        ).toMatchObject({
          _tag: "BoardEditConflictError",
          conflicts: expect.arrayContaining([{ id: api.id, current: token(api) }]),
        });
      }
      expect(
        yield* callAs(as, "board_apply", {
          edits: [{ op: "delete", id: api.id, expected: token(api) }],
        }).pipe(Effect.flip),
      ).toMatchObject({ code: "invalid_request", message: expect.stringContaining("revision") });
      const [label] = boundIds((yield* storedElements(threadId)).get(api.id), "text");
      expect((yield* storedElements(threadId)).get(label!)).toMatchObject({
        originalText: "Gateway",
        isDeleted: false,
      });

      // Writing only the element the agent holds a token for needs no fresh read.
      yield* callAs(as, "board_apply", {
        revision: read.revision,
        edits: [{ op: "patch", id: db.id, expected: token(db), backgroundColor: "#ffc9c9" }],
      });
      const fresh = yield* callAs(as, "board_get", { ids: [api.id] });
      yield* callAs(as, "board_apply", {
        revision: fresh.revision,
        edits: [{ op: "patch", id: api.id, expected: token(fresh.elements[0]!), label: "Edge" }],
      });
      expect((yield* callAs(as, "board_get", { ids: [api.id] })).elements[0]?.label).toBe("Edge");
    }),
  );

  it.effect("reroutes arrows when a label grows its box, and refuses to bend elbow arrows", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-routing");
      const as = threadCaller(threadId);
      yield* callAs(as, "board_create", {});
      const { ids } = yield* callAs(as, "board_apply", {
        edits: [
          box("a", 0, "A"),
          box("b", 300, "B"),
          { op: "create", type: "arrow", id: "link", start: "a", end: "b" },
        ],
      });
      const before = (yield* storedElements(threadId)).get(ids.link!)!;
      expect(before.y).toBe(30);
      let read = yield* callAs(as, "board_get", { ids: [ids.a!] });
      const relabeled = yield* callAs(as, "board_apply", {
        revision: read.revision,
        edits: [
          {
            op: "patch",
            id: ids.a!,
            expected: token(read.elements[0]!),
            label: "A label long enough to wrap onto several lines inside this box",
          },
        ],
      });
      const stored = yield* storedElements(threadId);
      expect(stored.get(ids.a!)!.height).toBeGreaterThan(60);
      expect(relabeled.elements.map((element) => element.id)).toContain(ids.link);
      expect(stored.get(ids.link!)!.y).not.toBe(30);
      // Only the end on the box that grew moves; the end on unchanged B stays put.
      const farEnd = (arrow: Record<string, unknown>) => {
        const points = arrow["points"] as ReadonlyArray<readonly [number, number]>;
        const [dx, dy] = points[points.length - 1]!;
        return [Math.round((arrow["x"] as number) + dx), Math.round((arrow["y"] as number) + dy)];
      };
      expect(farEnd(stored.get(ids.link!)!)).toEqual(farEnd(before));

      yield* userEdit(threadId, ids.link!, { elbowed: true });
      read = yield* callAs(as, "board_get", {});
      const b = read.elements.find((element) => element.id === ids.b)!;
      for (const edit of [
        { op: "patch", id: b.id, expected: token(b), x: 500 },
        { op: "patch", id: b.id, expected: token(b), label: "B, now long enough to grow its box" },
      ] as const) {
        expect(
          yield* callAs(as, "board_apply", { revision: read.revision, edits: [edit] }).pipe(
            Effect.flip,
          ),
        ).toMatchObject({ code: "invalid_request", message: expect.stringContaining("elbow") });
      }
      yield* callAs(as, "board_apply", {
        revision: read.revision,
        edits: [{ op: "patch", id: b.id, expected: token(b), strokeColor: "#e03131" }],
      });
    }),
  );

  it.effect("refuses reroutes onto rotated shapes and moves of frames", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-rotated");
      const as = threadCaller(threadId);
      yield* callAs(as, "board_create", {});
      const { ids } = yield* callAs(as, "board_apply", {
        edits: [
          box("a", 0, "A"),
          box("b", 300, "B"),
          { op: "create", type: "arrow", id: "link", start: "a", end: "b" },
        ],
      });
      yield* userEdit(threadId, ids.b!, { angle: 0.5 });
      let read = yield* callAs(as, "board_get", {});
      const a = read.elements.find((element) => element.id === ids.a)!;
      expect(
        yield* callAs(as, "board_apply", {
          revision: read.revision,
          edits: [{ op: "patch", id: a.id, expected: token(a), x: 40 }],
        }).pipe(Effect.flip),
      ).toMatchObject({ code: "invalid_request", message: expect.stringContaining("rotated") });

      yield* userEdit(threadId, ids.a!, { type: "frame" });
      // A shape inside a live frame cannot be moved by an agent.
      yield* userEdit(threadId, ids.b!, { frameId: ids.a!, angle: 0 });
      read = yield* callAs(as, "board_get", {});
      const framed = read.elements.find((element) => element.id === ids.b)!;
      expect(
        yield* callAs(as, "board_apply", {
          revision: read.revision,
          edits: [{ op: "patch", id: framed.id, expected: token(framed), x: 4000 }],
        }).pipe(Effect.flip),
      ).toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("inside a frame"),
      });
      const frame = read.elements.find((element) => element.id === ids.a)!;
      expect(
        yield* callAs(as, "board_apply", {
          revision: read.revision,
          edits: [{ op: "patch", id: frame.id, expected: token(frame), x: 40 }],
        }).pipe(Effect.flip),
      ).toMatchObject({ code: "invalid_request", message: expect.stringContaining("frame") });
    }),
  );

  it.effect("keeps labels as laid out on a move and releases a deleted frame's children", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-frames");
      const as = threadCaller(threadId);
      yield* callAs(as, "board_create", {});
      const { ids } = yield* callAs(as, "board_apply", {
        edits: [box("a", 0, "A"), box("b", 300, "B")],
      });
      const labelId = (yield* storedElements(threadId)).get(ids.a!)!["boundElements"] as Array<{
        id: string;
      }>;
      const label = labelId[0]!.id;
      yield* userEdit(threadId, label, { verticalAlign: "top", y: 2 });
      let read = yield* callAs(as, "board_get", {});
      const a = read.elements.find((element) => element.id === ids.a)!;
      yield* callAs(as, "board_apply", {
        revision: read.revision,
        edits: [{ op: "patch", id: a.id, expected: token(a), y: 50 }],
      });
      const moved = (yield* storedElements(threadId)).get(label)!;
      expect(moved["y"]).toBe(2 + 50 - (a.y as number));
      expect(moved["verticalAlign"]).toBe("top");
      // Two patches to one box in a batch move its label once, from where the first left it.
      read = yield* callAs(as, "board_get", {});
      const again = read.elements.find((element) => element.id === ids.a)!;
      const labelX = moved["x"] as number;
      yield* callAs(as, "board_apply", {
        revision: read.revision,
        edits: [
          { op: "patch", id: again.id, expected: token(again), x: (again.x as number) + 30 },
          { op: "patch", id: again.id, expected: token(again), y: (again.y as number) + 10 },
        ],
      });
      expect((yield* storedElements(threadId)).get(label)!["x"]).toBe(labelX + 30);

      yield* userEdit(threadId, ids.a!, { type: "frame" });
      yield* userEdit(threadId, ids.b!, { frameId: ids.a! });
      read = yield* callAs(as, "board_get", {});
      const frame = read.elements.find((element) => element.id === ids.a)!;
      yield* callAs(as, "board_apply", {
        revision: read.revision,
        edits: [{ op: "delete", id: frame.id, expected: token(frame) }],
      });
      expect((yield* storedElements(threadId)).get(ids.b!)!["frameId"]).toBeNull();

      yield* userEdit(threadId, ids.b!, { angle: 0.5 });
      read = yield* callAs(as, "board_get", {});
      expect(
        yield* callAs(as, "board_apply", {
          revision: read.revision,
          edits: [box("c", 600, "C"), { op: "create", type: "arrow", start: "c", end: ids.b! }],
        }).pipe(Effect.flip),
      ).toMatchObject({ code: "invalid_request", message: expect.stringContaining("rotated") });
    }),
  );

  it.effect("pages board_get by size and searches text past the preview", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-pages");
      const as = threadCaller(threadId);
      yield* callAs(as, "board_create", {});
      yield* callAs(as, "board_apply", {
        edits: Array.from({ length: 60 }, (_, i) => ({
          op: "create" as const,
          type: "text" as const,
          x: 0,
          y: i * 40,
          text: `${"x".repeat(1_900)} note-${i}`,
        })),
      });
      const first = yield* callAs(as, "board_get", {});
      expect(first.total).toBe(60);
      expect(first.elements.length).toBeGreaterThan(1);
      expect(first.elements.length).toBeLessThan(60);
      expect(JSON.stringify(first.elements).length).toBeLessThanOrEqual(32_000);
      expect(first.elements[0]!.text).toMatch(/^x{500}…$/);

      const seen = new Set(first.elements.map((element) => element.id));
      let cursor = first.nextCursor;
      while (cursor !== undefined) {
        const next = yield* callAs(as, "board_get", { cursor });
        for (const element of next.elements) seen.add(element.id);
        cursor = next.nextCursor;
      }
      expect(seen.size).toBe(60);

      const found = yield* callAs(as, "board_get", { text: "NOTE-7" });
      expect(found.elements).toHaveLength(1);
      expect(found.elements[0]!.text).toMatch(/…$/);
    }),
  );

  it.effect("treats a whitespace-only label as no label", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-blank-labels");
      const as = threadCaller(threadId);
      yield* callAs(as, "board_create", {});
      const { ids } = yield* callAs(as, "board_apply", {
        edits: [box("blank", 0, "  \n "), box("named", 300, "Named")],
      });
      let stored = yield* storedElements(threadId);
      expect(boundIds(stored.get(ids.blank!), "text")).toEqual([]);
      expect([...stored.values()].filter((element) => element.type === "text")).toHaveLength(1);

      const read = yield* callAs(as, "board_get", { ids: [ids.named!] });
      yield* callAs(as, "board_apply", {
        revision: read.revision,
        edits: [{ op: "patch", id: ids.named!, expected: token(read.elements[0]!), label: " \t" }],
      });
      stored = yield* storedElements(threadId);
      expect(boundIds(stored.get(ids.named!), "text")).toEqual([]);
      expect(
        [...stored.values()].filter((element) => element.type === "text" && !element.isDeleted),
      ).toEqual([]);
    }),
  );

  it.effect("acts only on the calling thread's own board", () =>
    Effect.gen(function* () {
      const other = threadCaller(OTHER_THREAD);
      expect((yield* callAs(other, "board_get", {})).boardId).toBeNull();
      yield* callAs(other, "board_create", {});
      yield* callAs(other, "board_apply", {
        edits: [{ op: "create", type: "text", x: 0, y: 0, text: "Mine" }],
      });
      expect((yield* callAs(other, "board_get", {})).elements).toMatchObject([{ text: "Mine" }]);
      expect(
        (yield* call("board_get", { text: "Mine" })).elements,
        "another thread's edit never reaches this board",
      ).toEqual([]);

      for (const tool of Object.values(BoardToolkit.tools)) {
        const fields = Object.keys(
          (tool.parametersSchema as unknown as { fields?: object }).fields ?? {},
        );
        expect(fields).not.toContain("threadId");
        expect(fields).not.toContain("boardId");
      }
      expect(yield* callAs(outsideClient, "board_get", {}).pipe(Effect.flip)).toMatchObject({
        code: "thread_credential_required",
      });
    }),
  );

  it.effect("lets a plan-mode thread read the board but not change it", () =>
    Effect.gen(function* () {
      const plan = threadCaller(PLAN_THREAD);
      const boards = yield* BoardService.BoardService;
      yield* boards.create(PLAN_THREAD);
      expect((yield* callAs(plan, "board_get", {})).revision).toBe(0);
      const refused = { _tag: "OrchestratorMcpFailure", code: "capability_denied" };
      expect(yield* callAs(plan, "board_create", {}).pipe(Effect.flip)).toMatchObject(refused);
      expect(
        yield* callAs(plan, "board_apply", {
          edits: [box("a", 0, "A")],
        }).pipe(Effect.flip),
      ).toMatchObject(refused);
      expect((yield* callAs(plan, "board_get", {})).revision).toBe(0);
    }),
  );
});

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "board-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "board-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect("sends a conflict's ids and current tokens to the agent over MCP", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const callTool = (name: string, args: object) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            threadCaller(ThreadId.make("thread-mcp")),
          ),
          Effect.provideService(McpSchema.McpServerClient, mcpClient),
        );
    yield* callTool("board_create", {});
    const created = yield* callTool("board_apply", { edits: [box("a", 0, "A")] });
    const id = (created.structuredContent as { ids: Record<string, string> }).ids.a!;
    const stale = yield* callTool("board_apply", {
      revision: 1,
      edits: [{ op: "patch", id, expected: { version: 0, versionNonce: 0 }, x: 10 }],
    });
    expect(stale.isError).toBe(true);
    const [content] = stale.content;
    assert(content?.type === "text");
    expect(JSON.parse(content.text)).toEqual({
      _tag: "BoardEditConflictError",
      message: expect.stringContaining("board_get"),
      conflicts: [
        { id, current: { version: expect.any(Number), versionNonce: expect.any(Number) } },
      ],
    });
  }).pipe(
    Effect.provide(
      McpHttpServer.toolkitRegistration(BoardToolkit, BoardHandlers.layer).pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(layerDependencies),
      ),
    ),
  ),
);
