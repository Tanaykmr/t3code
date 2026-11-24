import type { BoardElement } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  acknowledge,
  copyWithFreshIds,
  createBoardSession,
  editorStamp,
  markApplied,
  observeEditor,
  reconcile,
  rejectPending,
  seedScene,
  takeBatch,
} from "./boardSync";

const element = (id: string, overrides: Partial<BoardElement> = {}): BoardElement => ({
  id,
  type: "rectangle",
  version: 1,
  versionNonce: 10,
  index: `a${id}`,
  isDeleted: false,
  x: 0,
  ...overrides,
});

const take = (session: ReturnType<typeof createBoardSession>, mutationId = "m1") =>
  takeBatch(session, { committedFileIds: new Set(), editorFiles: {}, mutationId });

const scene = (elements: ReadonlyArray<BoardElement>, orderRevision = 1, revision = 1) => ({
  revision,
  elements,
  orderRevision,
  viewBackgroundColor: "#ffffff",
});

/** A session whose editor shows `records` as committed. */
const synced = (records: ReadonlyArray<BoardElement>) => {
  const session = createBoardSession();
  session.shownBackground = "#ffffff";
  markApplied(
    session,
    records,
    new Map(records.map((r) => [r.id, editorStamp(r)])),
    scene(records),
  );
  return session;
};

describe("board sync", () => {
  it("sends a new element as a create and nothing once acknowledged", () => {
    const session = synced([]);
    expect(observeEditor(session, [element("a")], "#ffffff")).toBe(true);
    const batch = take(session);
    expect(batch?.operations).toEqual([{ type: "create", element: element("a") }]);
    acknowledge(session, {
      revision: 1,
      orderRevision: 1,
      elements: [{ id: "a", version: 2, versionNonce: 99, index: "aa" }],
    });
    expect(session.drafts.size).toBe(0);
    expect(observeEditor(session, [element("a")], "#ffffff")).toBe(false);
    // Before the stream reaches the commit, the older record must not roll the editor back.
    expect(reconcile(session, scene([], 1, 0), [element("a")], new Set())).toBeNull();
    const canonical = element("a", { version: 2, versionNonce: 99, index: "aa" });
    const next = reconcile(session, scene([canonical]), [element("a")], new Set());
    expect(next?.applied).toEqual([canonical]);
    markApplied(
      session,
      next!.applied,
      new Map([["a", editorStamp(canonical)]]),
      scene([canonical]),
    );
    expect(reconcile(session, scene([canonical]), [canonical], new Set())).toBeNull();
    expect(observeEditor(session, [canonical], "#ffffff")).toBe(false);
  });

  it("expects the token of the record the edit started from, and extends its own receipt", () => {
    const session = synced([element("a", { version: 5, versionNonce: 50 })]);
    observeEditor(session, [element("a", { version: 6, x: 10 })], "#ffffff");
    expect(take(session)?.operations[0]).toMatchObject({
      type: "replace",
      expected: { version: 5, versionNonce: 50 },
    });
    observeEditor(session, [element("a", { version: 7, x: 20 })], "#ffffff");
    acknowledge(session, {
      revision: 2,
      orderRevision: 1,
      elements: [{ id: "a", version: 7, versionNonce: 70, index: "aa" }],
    });
    expect(take(session, "m2")?.operations[0]).toMatchObject({
      type: "replace",
      element: { version: 7, x: 20 },
      expected: { version: 7, versionNonce: 70 },
    });
  });

  it("maps tombstone transitions to delete and restore", () => {
    const session = synced([element("a"), element("b", { isDeleted: true })]);
    observeEditor(
      session,
      [element("a", { version: 2, isDeleted: true }), element("b", { version: 2 })],
      "#ffffff",
    );
    expect(take(session)?.operations.map((operation) => operation.type)).toEqual([
      "delete",
      "restore",
    ]);
  });

  it("fences a reorder with the displayed order revision", () => {
    const session = synced([element("a")]);
    observeEditor(session, [element("a", { version: 2, index: "b0" })], "#ffffff");
    expect(take(session)?.expectedOrderRevision).toBe(1);
  });

  it("freezes the reorder fence at the order the edit started from", () => {
    const session = synced([element("a"), element("b")]);
    observeEditor(session, [element("a", { version: 2, index: "b0" }), element("b")], "#ffffff");
    // Another client reorders before this draft is sent.
    session.shownOrderRevision = 4;
    expect(take(session)?.expectedOrderRevision).toBe(1);
  });

  it("deletes records that a scene-replacing import dropped", () => {
    const session = synced([element("a")]);
    expect(observeEditor(session, [element("b")], "#ffffff")).toBe(true);
    expect(take(session)?.operations).toEqual(
      expect.arrayContaining([
        { type: "delete", id: "a", expected: { version: 1, versionNonce: 10 } },
        { type: "create", element: element("b") },
      ]),
    );
  });

  it("sends each new image with its bytes and holds images whose bytes are missing", () => {
    const session = synced([]);
    const images = Array.from({ length: 10 }, (_, index) =>
      element(`i${index}`, { type: "image", fileId: `f${index}` }),
    );
    observeEditor(session, images, "#ffffff");
    const editorFiles = Object.fromEntries(
      images
        .slice(0, 9)
        .map((_, index) => [`f${index}`, { mimeType: "image/png", dataURL: "data:" }]),
    );
    const batch = takeBatch(session, {
      committedFileIds: new Set(),
      editorFiles,
      mutationId: "m1",
    });
    expect(batch?.files.map((file) => file.id)).toEqual(
      batch?.operations.map((operation) =>
        operation.type === "create" ? operation.element["fileId"] : null,
      ),
    );
    expect(batch?.operations).toHaveLength(8);
    expect(session.drafts.has("i8") && session.drafts.has("i9")).toBe(true);
  });

  it("records the sent deletion state, not a newer local undo", () => {
    const session = synced([element("a")]);
    observeEditor(session, [element("a", { version: 2, isDeleted: true })], "#ffffff");
    take(session);
    // The user undoes the delete before the receipt arrives.
    observeEditor(session, [element("a", { version: 3 })], "#ffffff");
    acknowledge(session, {
      revision: 2,
      orderRevision: 1,
      elements: [{ id: "a", version: 2, versionNonce: 20, index: "aa" }],
    });
    expect(take(session, "m2")?.operations[0]).toMatchObject({
      type: "restore",
      expected: { version: 2, versionNonce: 20 },
    });
  });

  it("applies a repaired canonical record after a gesture that held it", () => {
    const session = synced([]);
    observeEditor(session, [element("a", { index: "a0" })], "#ffffff");
    take(session);
    acknowledge(session, {
      revision: 1,
      orderRevision: 1,
      elements: [{ id: "a", version: 2, versionNonce: 20, index: "a0V" }],
    });
    const canonical = element("a", { version: 2, versionNonce: 20, index: "a0V" });
    // The user holds the element while its canonical record arrives.
    expect(reconcile(session, scene([canonical]), [element("a")], new Set(["a"]))).toBeNull();
    expect(reconcile(session, scene([canonical]), [element("a")], new Set())?.applied).toEqual([
      canonical,
    ]);
  });

  it("does not resend an import's deletion once its receipt is in", () => {
    const session = synced([element("a")]);
    observeEditor(session, [], "#ffffff");
    take(session);
    acknowledge(session, {
      revision: 2,
      orderRevision: 1,
      elements: [{ id: "a", version: 3, versionNonce: 30, index: "aa" }],
    });
    // The editor still lacks the record before the stream delivers the tombstone.
    observeEditor(session, [], "#ffffff");
    expect(take(session, "m2")).toBeNull();
  });

  it("keeps a batch under the element byte budget", () => {
    const session = synced([]);
    const big = "x".repeat(200 * 1024);
    observeEditor(
      session,
      Array.from({ length: 30 }, (_, index) => element(`b${index}`, { text: big })),
      "#ffffff",
    );
    const first = take(session);
    expect(first!.operations.length).toBeGreaterThan(0);
    expect(first!.operations.length).toBeLessThan(30);
    expect(JSON.stringify(first!.operations).length).toBeLessThan(4 * 1024 * 1024);
  });

  it("advances the order fence across this editor's own reorder", () => {
    const session = synced([element("a"), element("b")]);
    observeEditor(session, [element("a", { version: 2, index: "b0" }), element("b")], "#ffffff");
    expect(take(session)?.expectedOrderRevision).toBe(1);
    observeEditor(session, [element("a", { version: 3, index: "c0" }), element("b")], "#ffffff");
    acknowledge(session, {
      revision: 2,
      orderRevision: 2,
      elements: [{ id: "a", version: 3, versionNonce: 30, index: "b0" }],
    });
    expect(take(session, "m2")?.expectedOrderRevision).toBe(2);
  });

  it("keeps an import's deletion queued behind an in-flight edit of the same record", () => {
    const session = synced([element("a")]);
    observeEditor(session, [element("a", { version: 2, x: 5 })], "#ffffff");
    take(session);
    // The user opens a file that drops the record while the edit is being saved.
    observeEditor(session, [], "#ffffff");
    acknowledge(session, {
      revision: 2,
      orderRevision: 1,
      elements: [{ id: "a", version: 3, versionNonce: 30, index: "aa" }],
    });
    expect(take(session, "m2")?.operations).toEqual([
      { type: "delete", id: "a", expected: { version: 3, versionNonce: 30 } },
    ]);
  });

  it("does not credit an unrelated commit with a peer's reorder", () => {
    const session = synced([element("a"), element("b")]);
    observeEditor(session, [element("a", { version: 2, x: 5 }), element("b")], "#ffffff");
    take(session);
    observeEditor(
      session,
      [element("a", { version: 2, x: 5 }), element("b", { version: 2, index: "b5" })],
      "#ffffff",
    );
    acknowledge(session, {
      revision: 3,
      orderRevision: 2,
      elements: [{ id: "a", version: 3, versionNonce: 30, index: "aa" }],
    });
    expect(take(session, "m2")?.expectedOrderRevision).toBe(1);
  });

  it("sees an imported record that keeps the version but changes its content", () => {
    const session = synced([element("a")]);
    expect(observeEditor(session, [element("a", { versionNonce: 77, x: 40 })], "#ffffff")).toBe(
      true,
    );
  });

  it("forgets a create that an import dropped before it was sent", () => {
    const session = synced([]);
    observeEditor(session, [element("n")], "#ffffff");
    observeEditor(session, [], "#ffffff");
    expect(take(session)).toBeNull();
  });

  it("sizes a delete by the record the server stores as its tombstone", () => {
    const session = synced(Array.from({ length: 25 }, (_, index) => element(`d${index}`)));
    observeEditor(session, [], "#ffffff");
    const batch = takeBatch(session, {
      committedFileIds: new Set(),
      editorFiles: {},
      mutationId: "m1",
      committedBytes: () => 200 * 1024,
    });
    expect(batch!.operations.length).toBeLessThan(25);
  });

  it("deletes an in-flight create that an import dropped, once its receipt arrives", () => {
    const session = synced([]);
    observeEditor(session, [element("n")], "#ffffff");
    take(session);
    observeEditor(session, [], "#ffffff");
    acknowledge(session, {
      revision: 1,
      orderRevision: 1,
      previousOrderRevision: 0,
      elements: [{ id: "n", version: 2, versionNonce: 20, index: "an" }],
    });
    expect(take(session, "m2")?.operations).toEqual([
      { type: "delete", id: "n", expected: { version: 2, versionNonce: 20 } },
    ]);
  });

  it("reseeds a remounted editor with acknowledged records in drawing order", () => {
    const session = synced([element("b", { index: "a5" })]);
    observeEditor(
      session,
      [element("b", { index: "a5" }), element("a", { index: "a1" })],
      "#ffffff",
    );
    take(session);
    acknowledge(session, {
      revision: 2,
      orderRevision: 2,
      previousOrderRevision: 1,
      elements: [{ id: "a", version: 2, versionNonce: 20, index: "a1" }],
    });
    // The stream is still at revision 1, without the new record.
    const seed = seedScene(session, scene([element("b", { index: "a5" })], 1, 1));
    expect(seed.elements.map((record) => record.id)).toEqual(["a", "b"]);
    expect(seed.acknowledged.map((record) => record.id)).toEqual(["a"]);
  });

  it("saves a background revert made while the change is in flight", () => {
    const session = synced([]);
    observeEditor(session, [], "#ff0000");
    take(session);
    expect(observeEditor(session, [], "#ffffff")).toBe(true);
    acknowledge(session, { revision: 2, orderRevision: 1, elements: [] });
    expect(take(session, "m2")?.settings).toEqual({ viewBackgroundColor: "#ffffff" });
  });

  it("steps a reorder's fence over this editor's own create", () => {
    const session = synced([element("a"), element("b")]);
    observeEditor(session, [element("a"), element("b"), element("n", { index: "c0" })], "#ffffff");
    take(session);
    observeEditor(
      session,
      [element("a", { version: 2, index: "b5" }), element("b"), element("n", { index: "c0" })],
      "#ffffff",
    );
    acknowledge(session, {
      revision: 2,
      orderRevision: 2,
      previousOrderRevision: 1,
      elements: [{ id: "n", version: 2, versionNonce: 20, index: "c0" }],
    });
    expect(take(session, "m2")?.expectedOrderRevision).toBe(2);
  });

  it("cancels an import's queued deletion when the record comes back unchanged", () => {
    const session = synced([element("a")]);
    observeEditor(session, [], "#ffffff");
    expect(observeEditor(session, [element("a")], "#ffffff")).toBe(true);
    expect(take(session)).toBeNull();
  });

  it("restores a record whose import deletion is already in flight", () => {
    const session = synced([element("a")]);
    observeEditor(session, [], "#ffffff");
    take(session);
    observeEditor(session, [element("a")], "#ffffff");
    acknowledge(session, {
      revision: 2,
      orderRevision: 1,
      previousOrderRevision: 1,
      elements: [{ id: "a", version: 3, versionNonce: 30, index: "aa" }],
    });
    expect(take(session, "m2")?.operations[0]).toMatchObject({
      type: "restore",
      expected: { version: 3, versionNonce: 30 },
    });
  });

  it("restores a record dropped and restored twice while its deletion is in flight", () => {
    const session = synced([element("a")]);
    observeEditor(session, [], "#ffffff");
    take(session);
    observeEditor(session, [element("a")], "#ffffff");
    observeEditor(session, [], "#ffffff");
    observeEditor(session, [element("a")], "#ffffff");
    acknowledge(session, {
      revision: 2,
      orderRevision: 1,
      previousOrderRevision: 1,
      elements: [{ id: "a", version: 3, versionNonce: 30, index: "aa" }],
    });
    expect(take(session, "m2")?.operations[0]).toMatchObject({ type: "restore" });
  });

  it("re-shows the committed background after a rejected color change", () => {
    const session = synced([element("a")]);
    observeEditor(session, [element("a", { version: 2, x: 4 })], "#ff0000");
    take(session);
    rejectPending(session);
    expect(session.shownBackground).toBeNull();
    expect(session.draftBackground).toBeNull();
  });

  it("holds remote records under local drafts and gestures, and applies the rest", () => {
    const session = synced([element("a"), element("b"), element("c")]);
    observeEditor(
      session,
      [element("a", { version: 2, x: 5 }), element("b"), element("c")],
      "#ffffff",
    );
    const remote = [
      element("a", { version: 3, versionNonce: 30 }),
      element("b", { version: 3, versionNonce: 30 }),
      element("c", { version: 3, versionNonce: 30 }),
    ];
    const next = reconcile(
      session,
      scene(remote),
      [element("a", { version: 2, x: 5 }), element("b"), element("c")],
      new Set(["b"]),
    );
    expect(next?.applied.map((record) => record.id)).toEqual(["c"]);
    expect(next?.elements.find((record) => record.id === "a")).toMatchObject({ x: 5 });
  });

  it("does not echo an inbound apply as a local edit", () => {
    const session = synced([]);
    const remote = element("a", { version: 4, versionNonce: 40 });
    const next = reconcile(session, scene([remote]), [], new Set());
    // The editor may repair the record and bump its version as it loads it.
    markApplied(session, next!.applied, new Map([["a", "5:10"]]), scene([remote]));
    expect(observeEditor(session, [element("a", { version: 5 })], "#ffffff")).toBe(false);
  });

  it("sets a rejected batch aside and returns the editor to the committed scene", () => {
    const session = synced([element("a")]);
    observeEditor(session, [element("a", { version: 2, x: 9 }), element("n")], "#ffffff");
    take(session);
    rejectPending(session);
    expect(session.rejected?.map((record) => record.id).sort()).toEqual(["a", "n"]);
    expect(session.drafts.size).toBe(0);
    const committed = element("a", { version: 3, versionNonce: 30 });
    const next = reconcile(
      session,
      scene([committed]),
      [element("a", { version: 2, x: 9 }), element("n")],
      new Set(),
    );
    expect(next?.elements).toEqual([committed]);
  });

  it("copies a rejected draft under fresh ids with its bindings intact", () => {
    let counter = 0;
    const copies = copyWithFreshIds(
      [
        element("box", {
          boundElements: [
            { id: "label", type: "text" },
            { id: "gone", type: "arrow" },
          ],
        }),
        element("label", { type: "text", containerId: "box" }),
        element("arrow", { type: "arrow", endBinding: { elementId: "box", focus: 0, gap: 1 } }),
      ],
      () => `fresh${++counter}`,
    );
    expect(copies.map((copy) => copy.id)).toEqual(["fresh1", "fresh2", "fresh3"]);
    expect(copies[0]?.["boundElements"]).toEqual([{ id: "fresh2", type: "text" }]);
    expect(copies[1]?.["containerId"]).toBe("fresh1");
    expect(copies[2]?.["endBinding"]).toMatchObject({ elementId: "fresh1" });
  });
});
