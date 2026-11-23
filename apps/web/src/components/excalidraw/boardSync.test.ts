import type { BoardElement } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  acknowledge,
  copyWithFreshIds,
  createBoardSession,
  markApplied,
  observeEditor,
  reconcile,
  rejectPending,
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

const scene = (elements: ReadonlyArray<BoardElement>, orderRevision = 1) => ({
  elements,
  orderRevision,
  viewBackgroundColor: "#ffffff",
});

/** A session whose editor shows `records` as committed. */
const synced = (records: ReadonlyArray<BoardElement>) => {
  const session = createBoardSession();
  session.shownBackground = "#ffffff";
  markApplied(session, records, new Map(records.map((r) => [r.id, r.version])), scene(records));
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
    expect(
      reconcile(
        session,
        scene([element("a", { version: 2, versionNonce: 99 })]),
        [element("a")],
        new Set(),
      ),
    ).toBeNull();
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

  it("holds remote records under local drafts and gestures, and applies the rest", () => {
    const session = synced([element("a"), element("b"), element("c")]);
    observeEditor(session, [element("a", { version: 2, x: 5 })], "#ffffff");
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
    markApplied(session, next!.applied, new Map([["a", 5]]), scene([remote]));
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
