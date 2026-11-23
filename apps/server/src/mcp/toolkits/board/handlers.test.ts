import { type BoardElement, EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import type { Tool } from "effect/ai";

import * as BoardService from "../../../board/BoardService.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
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
    return yield* toolkit.handle(name, params as never).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof BoardToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    );
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
        expect(firstPage.nextCursor).toBe("1:2");
        const secondPage = yield* call("board_get", { limit: 2, cursor: "1:2" });
        expect(secondPage.elements.map((element) => element.id)).toEqual([cache.id, reads.id]);
      }),
    );

    it.effect("moves a shape's label and arrows with it, and rejects a stale token", () =>
      Effect.gen(function* () {
        const board = (yield* call("board_get", {})).elements;
        const cache = board.find((element) => element.label === "Cache")!;
        const stale = { version: cache.version - 1, versionNonce: cache.versionNonce };

        const conflict = yield* call("board_apply", {
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
        const board = (yield* call("board_get", {})).elements;
        const api = board.find((element) => element.label === "API")!;
        const reads = board.find((element) => element.label === "reads")!;
        yield* call("board_apply", {
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
