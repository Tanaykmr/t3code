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
      const created = yield* Deferred.make<void>();
      const fiber = yield* boards.subscribe(threadId).pipe(
        Stream.tap((event) =>
          event.type === "snapshot"
            ? Deferred.succeed(created, undefined)
            : Deferred.succeed(ready, undefined),
        ),
        Stream.take(4),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(ready);
      const board = yield* boards.create(threadId);
      yield* Deferred.await(created);
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
  it.effect("drops old deltas for a lagging subscriber and can reopen at the latest revision", () =>
    Effect.gen(function* () {
      const boards = yield* BoardService.BoardService;
      const board = yield* boards.create(threadId);
      const ready = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const fiber = yield* boards.subscribe(threadId).pipe(
        Stream.tap((event) =>
          event.type === "snapshot"
            ? Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(resume)))
            : Effect.void,
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(ready);
      for (const revision of [1, 2, 3]) {
        const id = `shape-${revision}`;
        yield* boards.apply({
          actor: "session-a",
          batch: batch(board, id, [{ type: "create", element: element(id) }]),
        });
      }
      yield* Deferred.succeed(resume, undefined);
      const events = yield* Fiber.join(fiber);
      expect(
        events.flatMap((event) => (event.type === "delta" ? [event.delta.revision] : [])),
      ).toEqual([2, 3]);
      const [snapshot] = yield* boards.subscribe(threadId).pipe(Stream.take(1), Stream.runCollect);
      expect(snapshot).toMatchObject({ type: "snapshot", snapshot: { board: { revision: 3 } } });
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
  it.effect(
    "replaces an oversized UTF-8 delta with a fresh snapshot for a lagging subscriber",
    () =>
      Effect.gen(function* () {
        const boards = yield* BoardService.BoardService;
        const board = yield* boards.create(threadId);
        const ready = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const fiber = yield* boards.subscribe(threadId).pipe(
          Stream.tap((event) =>
            event.type === "snapshot" && event.snapshot.board.revision === 0
              ? Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(resume)))
              : Effect.void,
          ),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Deferred.await(ready);
        const text = "é".repeat(110_000);
        const operations = Array.from({ length: 40 }, (_, index) => ({
          type: "create" as const,
          element: element(`large-${index}`, { type: "text", text, index: null }),
        }));
        expect(Buffer.byteLength(text) * operations.length).toBeGreaterThan(8 * 1024 * 1024);
        yield* boards.apply({ actor: "session-a", batch: batch(board, "large", operations) });
        const settings = { viewBackgroundColor: "#eeeeee" };
        yield* boards.apply({
          actor: "session-a",
          batch: batch(board, "settings", [], { settings }),
        });

        yield* Deferred.succeed(resume, undefined);
        const [, event] = yield* Fiber.join(fiber);
        expect(event).toMatchObject({
          type: "snapshot",
          snapshot: { board: { revision: 2 }, settings },
        });
        assert(event?.type === "snapshot");
        expect(event.snapshot.elements).toHaveLength(40);
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
  it.effect("fences reorders and keeps a repaired label right above its container", () =>
    Effect.gen(function* () {
      const boards = yield* BoardService.BoardService;
      const board = yield* boards.create(threadId);
      const first = yield* boards.apply({
        actor: "session-a",
        batch: batch(board, "o1", [
          { type: "create", element: element("box1", { index: "a5" }) },
          { type: "create", element: element("label1", { index: "a6", containerId: "box1" }) },
        ]),
      });
      const box1 = first.elements.find((entry) => entry.id === "box1");
      assert(box1 !== undefined);
      const unfenced = yield* boards
        .apply({
          actor: "session-a",
          batch: batch(board, "o2", [
            {
              type: "replace",
              element: element("box1", { index: "a9", version: box1.version }),
              expected: token(box1),
            },
          ]),
        })
        .pipe(Effect.flip);
      expect(unfenced).toMatchObject({ _tag: "BoardConflictError" });

      // Another editor created a second box and label at the same indices.
      const second = yield* boards.apply({
        actor: "session-b",
        batch: batch(board, "o3", [
          { type: "create", element: element("box2", { index: "a5" }) },
          { type: "create", element: element("label2", { index: "a6", containerId: "box2" }) },
        ]),
      });
      const order = new Map(second.elements.map((entry) => [entry.id, entry.index ?? ""]));
      const snapshot = yield* boards.get(threadId);
      const ids = snapshot?.elements.map((entry) => entry.id) ?? [];
      expect(ids.indexOf("label2")).toBe(ids.indexOf("box2") + 1);
      expect(ids.indexOf("label1")).toBe(ids.indexOf("box1") + 1);
      expect(order.get("box2")! < order.get("label2")!).toBe(true);
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
  it.effect("keeps a patched element's slot and fences a restore that moves it", () =>
    Effect.gen(function* () {
      const boards = yield* BoardService.BoardService;
      const board = yield* boards.create(threadId);
      const created = yield* boards.apply({
        actor: "session-a",
        batch: batch(board, "k1", [
          { type: "create", element: element("zz-old", { index: "a5" }) },
        ]),
      });
      const old = created.elements[0];
      assert(old !== undefined);
      // A create that sorts first claims the same index as an element patched in place.
      const second = yield* boards.apply({
        actor: "session-a",
        batch: batch(board, "k2", [
          {
            type: "replace",
            element: element("zz-old", { index: "a5", x: 9, version: old.version }),
            expected: token(old),
          },
          { type: "create", element: element("aa-new", { index: "a5" }) },
        ]),
      });
      const kept = second.elements.find((entry) => entry.id === "zz-old");
      expect(kept?.index).toBe("a5");
      assert(kept !== undefined);
      const deleted = yield* boards.apply({
        actor: "session-a",
        batch: batch(board, "k3", [{ type: "delete", id: "zz-old", expected: token(kept) }]),
      });
      const tomb = deleted.elements[0];
      assert(tomb !== undefined);
      const unfenced = yield* boards
        .apply({
          actor: "session-a",
          batch: batch(board, "k4", [
            {
              type: "restore",
              element: element("zz-old", { index: "b0", isDeleted: true, version: tomb.version }),
              expected: token(tomb),
            },
          ]),
        })
        .pipe(Effect.flip);
      expect(unfenced).toMatchObject({ _tag: "BoardConflictError" });
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
  it.effect("keeps frame membership pointing at live frames across concurrent edits", () =>
    Effect.gen(function* () {
      const boards = yield* BoardService.BoardService;
      const board = yield* boards.create(threadId);
      const made = yield* boards.apply({
        actor: "session-a",
        batch: batch(board, "f1", [
          { type: "create", element: element("frame", { type: "frame", index: "a1" }) },
          { type: "create", element: element("loose", { index: "a2" }) },
        ]),
      });
      const frame = made.elements.find((entry) => entry.id === "frame")!;
      const loose = made.elements.find((entry) => entry.id === "loose")!;
      // Editor B drops the shape into the frame; editor A, not having seen that, deletes it.
      yield* boards.apply({
        actor: "session-b",
        batch: batch(board, "f2", [
          {
            type: "replace",
            element: element("loose", { index: "a2", frameId: "frame", version: loose.version }),
            expected: token(loose),
          },
        ]),
      });
      yield* boards.apply({
        actor: "session-a",
        batch: batch(board, "f3", [{ type: "delete", id: "frame", expected: token(frame) }]),
      });
      const snapshot = yield* boards.get(threadId);
      const child = snapshot?.elements.find((entry) => entry.id === "loose");
      expect(child?.["frameId"]).toBeNull();

      // Joining a frame that is already deleted is undone in the same commit.
      const joined = yield* boards.apply({
        actor: "session-b",
        batch: batch(board, "f4", [
          { type: "create", element: element("late", { index: "a3", frameId: "frame" }) },
        ]),
      });
      expect(joined.elements[0]).toBeDefined();
      const after = yield* boards.get(threadId);
      expect(after?.elements.find((entry) => entry.id === "late")?.["frameId"]).toBeNull();
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
