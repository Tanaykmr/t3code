import {
  type BoardEditBatch,
  type BoardElement,
  type BoardHeader,
  type BoardStreamEvent,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as BoardService from "./BoardService.ts";

const threadId = ThreadId.make("thread-board");
const otherThreadId = ThreadId.make("thread-other");
const missingThreadId = ThreadId.make("thread-missing");

const layerThreads = Layer.succeed(ProjectionStore.ProjectionStoreV2, {
  getThreadTitles: (ids: ReadonlyArray<ThreadId>) =>
    Effect.succeed(
      Object.fromEntries(
        ids.filter((id) => id === threadId || id === otherThreadId).map((id) => [id, "Thread"]),
      ),
    ),
} as unknown as ProjectionStore.ProjectionStoreV2["Service"]);

const layer = it.layer(
  BoardService.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(layerThreads),
    Layer.provideMerge(SecureRandom.layerWebCrypto),
  ),
);

const element = (id: string, fields: Partial<BoardElement> = {}): BoardElement => ({
  id,
  type: "rectangle",
  version: 1,
  versionNonce: 7,
  index: "a0",
  isDeleted: false,
  x: 0,
  y: 0,
  ...fields,
});

const batch = (
  board: BoardHeader,
  mutationId: string,
  operations: BoardEditBatch["operations"],
  fields: Partial<BoardEditBatch> = {},
): BoardEditBatch => ({
  threadId: board.threadId,
  boardId: board.boardId,
  mutationId,
  operations,
  ...fields,
});

const token = (accepted: { readonly version: number; readonly versionNonce: number }) => ({
  version: accepted.version,
  versionNonce: accepted.versionNonce,
});

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

layer("BoardService", (it) => {
  it.effect("creates one board per thread and never creates on read", () =>
    Effect.gen(function* () {
      const boards = yield* BoardService.BoardService;
      expect(yield* boards.get(otherThreadId)).toBeNull();
      const first = yield* boards.create(otherThreadId);
      const second = yield* boards.create(otherThreadId);
      expect(second).toEqual(first);
      expect(first).toMatchObject({ threadId: otherThreadId, revision: 0, orderRevision: 0 });
      expect(yield* boards.create(missingThreadId).pipe(Effect.flip)).toMatchObject({
        _tag: "BoardNotFoundError",
      });
    }),
  );

  it.effect("commits edits, conflicts, receipts, and index repair against committed rows", () =>
    Effect.gen(function* () {
      const boards = yield* BoardService.BoardService;
      const board = yield* boards.create(threadId);
      const actor = "session-a";

      const created = yield* boards.apply({
        actor,
        batch: batch(board, "m1", [
          { type: "create", element: element("box", { index: "a0", version: 5 }) },
          { type: "create", element: element("text", { index: "a1" }) },
        ]),
      });
      expect(created).toMatchObject({ revision: 1, orderRevision: 1 });
      const [box, text] = created.elements;
      assert(box !== undefined && text !== undefined);
      expect(box).toMatchObject({ id: "box", version: 6, index: "a0" });

      // Two edits from the same revision to different elements both commit.
      const moveBox = yield* boards.apply({
        actor,
        batch: batch(board, "m2", [
          {
            type: "replace",
            element: element("box", { x: 10, version: 6 }),
            expected: token(box),
          },
        ]),
      });
      expect(moveBox).toMatchObject({ revision: 2, orderRevision: 1 });
      const editText = yield* boards.apply({
        actor: "session-b",
        batch: batch(board, "m3", [
          {
            type: "replace",
            element: element("text", { index: "a1", y: 4 }),
            expected: token(text),
          },
        ]),
      });
      expect(editText.revision).toBe(3);

      // A stale edit to the same element gets the current token and changes nothing.
      const [movedBox] = moveBox.elements;
      assert(movedBox !== undefined);
      const stale = yield* boards
        .apply({
          actor: "session-b",
          batch: batch(board, "m4", [
            { type: "replace", element: element("box", { x: 99 }), expected: token(box) },
          ]),
        })
        .pipe(Effect.flip);
      expect(stale).toMatchObject({
        _tag: "BoardConflictError",
        conflicts: [{ id: "box", current: token(movedBox) }],
      });

      // Delete wins; the stale update after it conflicts.
      const deleted = yield* boards.apply({
        actor,
        batch: batch(board, "m5", [{ type: "delete", id: "box", expected: token(movedBox) }]),
      });
      const [tombstone] = deleted.elements;
      assert(tombstone !== undefined);
      expect(
        yield* boards
          .apply({
            actor: "session-b",
            batch: batch(board, "m6", [
              { type: "replace", element: element("box"), expected: token(movedBox) },
            ]),
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "BoardConflictError", conflicts: [{ id: "box" }] });
      // IDs stay reserved after delete.
      expect(
        yield* boards
          .apply({
            actor,
            batch: batch(board, "m7", [{ type: "create", element: element("box") }]),
          })
          .pipe(Effect.flip),
      ).toMatchObject({
        _tag: "BoardConflictError",
        conflicts: [{ id: "box", current: token(tombstone) }],
      });

      // A retry returns the original receipt; reusing the id for another payload fails.
      const retry = yield* boards.apply({
        actor,
        batch: batch(board, "m5", [{ type: "delete", id: "box", expected: token(movedBox) }]),
      });
      expect(retry).toEqual(deleted);
      expect(
        yield* boards
          .apply({
            actor,
            batch: batch(board, "m5", [{ type: "delete", id: "text", expected: token(text) }]),
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "BoardMutationReuseError" });

      // Restore takes the tombstone's token.
      const restored = yield* boards.apply({
        actor,
        batch: batch(board, "m8", [
          {
            type: "restore",
            element: element("box", { version: 1, x: 10 }),
            expected: token(tombstone),
          },
        ]),
      });
      expect(restored.elements[0]?.version).toBe(tombstone.version + 1);

      // A colliding index is regenerated between its neighbours and returned.
      const collided = yield* boards.apply({
        actor,
        batch: batch(board, "m9", [{ type: "create", element: element("arrow", { index: "a0" }) }]),
      });
      const [arrow] = collided.elements;
      assert(arrow !== undefined && arrow.index !== null);
      expect(arrow.index > "a0" && arrow.index < "a1").toBe(true);
      expect(collided.orderRevision).toBe(restored.orderRevision + 1);

      // A stale order revision is a conflict.
      expect(
        yield* boards
          .apply({
            actor,
            batch: batch(
              board,
              "m10",
              [{ type: "create", element: element("late", { index: null }) }],
              {
                expectedOrderRevision: 0,
              },
            ),
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "BoardConflictError", conflicts: [] });

      const snapshot = yield* boards.get(threadId);
      assert(snapshot !== null);
      expect(snapshot.board).toMatchObject({ revision: collided.revision });
      expect(snapshot.elements.map((entry) => entry.id)).toEqual(["box", "arrow", "text"]);
      expect(snapshot.elements.find((entry) => entry.id === "box")).toMatchObject({
        isDeleted: false,
        x: 10,
      });

      // A new instance on the same database reads the committed rows.
      const restarted = yield* Effect.service(BoardService.BoardService).pipe(
        Effect.provide(BoardService.layer),
      );
      expect(yield* restarted.get(threadId)).toEqual(snapshot);
    }),
  );

  it.effect("stores files with the batch and serves their bytes", () =>
    Effect.gen(function* () {
      const boards = yield* BoardService.BoardService;
      const board = yield* boards.create(otherThreadId);
      const result = yield* boards.apply({
        actor: "session-a",
        batch: batch(
          board,
          "files-1",
          [{ type: "create", element: element("image", { type: "image", fileId: "f1" }) }],
          {
            files: [{ id: "f1", mimeType: "image/png", dataURL: PNG_DATA_URL }],
          },
        ),
      });
      expect(result.revision).toBe(1);
      const snapshot = yield* boards.get(otherThreadId);
      expect(snapshot?.files).toMatchObject([{ id: "f1", mimeType: "image/png", size: 70 }]);
      expect(
        yield* boards.getFiles({
          threadId: otherThreadId,
          boardId: board.boardId,
          fileIds: ["f1"],
        }),
      ).toEqual([{ id: "f1", mimeType: "image/png", dataURL: PNG_DATA_URL }]);
      expect(
        yield* boards
          .apply({
            actor: "session-a",
            batch: batch(board, "files-2", [], {
              files: [{ id: "f1", mimeType: "image/png", dataURL: "data:image/png;base64,AAAA" }],
            }),
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "BoardInvalidBatchError", reason: "file-conflict" });
    }),
  );
});

describe("BoardService subscriptions", () => {
  it.effect("streams missing, the created snapshot, then deltas in commit order", () =>
    Effect.gen(function* () {
      const boards = yield* BoardService.BoardService;
      const ready = yield* Deferred.make<void>();
      const fiber = yield* boards.subscribe(threadId).pipe(
        Stream.tap(() => Deferred.succeed(ready, undefined)),
        Stream.take(4),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(ready);
      const board = yield* boards.create(threadId);
      yield* boards.apply({
        actor: "session-a",
        batch: batch(board, "s1", [{ type: "create", element: element("one", { index: "a0" }) }]),
      });
      yield* boards.apply({
        actor: "session-a",
        batch: batch(board, "s2", [{ type: "create", element: element("two", { index: "a1" }) }]),
      });
      const events: ReadonlyArray<BoardStreamEvent> = yield* Fiber.join(fiber);
      expect(events.map((event) => event.type)).toEqual(["missing", "snapshot", "delta", "delta"]);
      expect(
        events.flatMap((event) => (event.type === "delta" ? [event.delta.revision] : [])),
      ).toEqual([1, 2]);

      const late = yield* boards.subscribe(threadId).pipe(Stream.take(1), Stream.runCollect);
      const [initial] = late;
      assert(initial?.type === "snapshot");
      expect(initial.snapshot.elements.map((entry) => entry.id)).toEqual(["one", "two"]);
    }).pipe(
      Effect.provide(
        BoardService.layer.pipe(
          Layer.provide(SqlitePersistence.layerMemory),
          Layer.provide(layerThreads),
          Layer.provide(SecureRandom.layerWebCrypto),
        ),
      ),
    ),
  );
  it.effect("removes a deleted thread's board and tells its subscribers", () =>
    Effect.gen(function* () {
      const boards = yield* BoardService.BoardService;
      const board = yield* boards.create(threadId);
      yield* boards.apply({
        actor: "session-a",
        batch: batch(board, "r1", [{ type: "create", element: element("doomed") }]),
      });
      const ready = yield* Deferred.make<void>();
      const fiber = yield* boards.subscribe(threadId).pipe(
        Stream.tap(() => Deferred.succeed(ready, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(ready);
      yield* boards.remove(threadId);
      const events: ReadonlyArray<BoardStreamEvent> = yield* Fiber.join(fiber);
      expect(events.map((event) => event.type)).toEqual(["snapshot", "missing"]);
      expect(yield* boards.get(threadId)).toBeNull();
      yield* boards.remove(threadId);
      expect((yield* boards.create(threadId)).boardId).not.toBe(board.boardId);
    }).pipe(
      Effect.provide(
        BoardService.layer.pipe(
          Layer.provide(SqlitePersistence.layerMemory),
          Layer.provide(layerThreads),
          Layer.provide(SecureRandom.layerWebCrypto),
        ),
      ),
    ),
  );
  it.effect("rejects invalid tombstone transitions, missing image bytes, and huge versions", () =>
    Effect.gen(function* () {
      const boards = yield* BoardService.BoardService;
      const board = yield* boards.create(threadId);
      const created = yield* boards.apply({
        actor: "session-a",
        batch: batch(board, "t1", [{ type: "create", element: element("live") }]),
      });
      const live = created.elements[0];
      assert(live !== undefined);
      const replaceAsDelete = yield* boards
        .apply({
          actor: "session-a",
          batch: batch(board, "t2", [
            {
              type: "restore",
              element: element("live", { version: live.version }),
              expected: token(live),
            },
          ]),
        })
        .pipe(Effect.flip);
      expect(replaceAsDelete).toMatchObject({
        _tag: "BoardConflictError",
        conflicts: [{ id: "live", current: token(live) }],
      });
      const missingFile = yield* boards
        .apply({
          actor: "session-a",
          batch: batch(board, "t3", [
            { type: "create", element: element("picture", { type: "image", fileId: "nope" }) },
          ]),
        })
        .pipe(Effect.flip);
      expect(missingFile).toMatchObject({ _tag: "BoardInvalidBatchError", reason: "file-missing" });
      const huge = yield* boards
        .apply({
          actor: "session-a",
          batch: batch(board, "t4", [
            { type: "create", element: element("huge", { version: Number.MAX_SAFE_INTEGER }) },
          ]),
        })
        .pipe(Effect.flip);
      expect(huge).toMatchObject({ _tag: "BoardInvalidBatchError", reason: "invalid-version" });
    }).pipe(
      Effect.provide(
        BoardService.layer.pipe(
          Layer.provide(SqlitePersistence.layerMemory),
          Layer.provide(layerThreads),
          Layer.provide(SecureRandom.layerWebCrypto),
        ),
      ),
    ),
  );
});
