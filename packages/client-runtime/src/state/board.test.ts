import type { BoardElement, BoardSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { isBoardStreamGapError, reduceBoardEvent } from "./board.ts";

const element = (id: string, index: string, version = 1): BoardElement => ({
  id,
  type: "rectangle",
  version,
  versionNonce: version,
  index,
  isDeleted: false,
});

const snapshot = {
  board: {
    boardId: "board-1",
    threadId: "thread-1",
    sceneFormatVersion: 1,
    revision: 3,
    orderRevision: 2,
    createdAt: "2026-11-24T00:00:00.000Z",
    updatedAt: "2026-11-24T00:00:00.000Z",
  },
  elements: [element("a", "a0"), element("b", "a1")],
  settings: { viewBackgroundColor: "#ffffff" },
  files: [],
} as unknown as BoardSnapshot;

const delta = (revision: number, elements: ReadonlyArray<BoardElement>) => ({
  type: "delta" as const,
  delta: {
    boardId: snapshot.board.boardId,
    revision,
    orderRevision: 3,
    mutationId: `m${revision}`,
    elements,
  },
});

const view = (value: ReturnType<typeof reduceBoardEvent>) => {
  if (isBoardStreamGapError(value)) throw value;
  return value;
};

describe("reduceBoardEvent", () => {
  it("folds ordered deltas into the snapshot in canonical order", () => {
    const ready = view(reduceBoardEvent(null, { type: "snapshot", snapshot }));
    const next = reduceBoardEvent(ready, delta(4, [element("c", "a05"), element("a", "a2", 2)]));
    expect(next).toMatchObject({ status: "ready", board: { revision: 4, orderRevision: 3 } });
    if (isBoardStreamGapError(next) || next.status !== "ready") throw new Error("not ready");
    expect(next.elements.map((record) => record.id)).toEqual(["c", "b", "a"]);
    expect(next.changed).toEqual(new Set(["c", "a"]));
  });

  it("ignores already-seen revisions and reports a gap", () => {
    const ready = view(reduceBoardEvent(null, { type: "snapshot", snapshot }));
    expect(reduceBoardEvent(ready, delta(3, []))).toBe(ready);
    expect(isBoardStreamGapError(reduceBoardEvent(ready, delta(5, [])))).toBe(true);
  });

  it("starts over from a fresh snapshot", () => {
    const ready = view(reduceBoardEvent(null, { type: "snapshot", snapshot }));
    const missing = reduceBoardEvent(ready, { type: "missing" });
    expect(missing).toEqual({ status: "missing" });
  });
});
