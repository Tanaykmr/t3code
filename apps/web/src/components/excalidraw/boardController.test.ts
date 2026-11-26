import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { BoardId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@excalidraw/excalidraw", () => ({
  CaptureUpdateAction: { IMMEDIATELY: "IMMEDIATELY", NEVER: "NEVER" },
  restoreElements: (elements: unknown) => elements,
}));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/board", () => ({
  boardEnvironment: { apply: "apply", getFiles: "getFiles" },
}));
const { command } = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: command,
  squashAtomCommandFailure: (failure: { error: unknown }) => failure.error,
}));

const { boardController } = await import("./boardController");
import type { ReadyBoardView } from "./boardController";

const target = (boardId: string) => ({
  environmentId: "env" as EnvironmentId,
  threadId: "thread" as ThreadId,
  boardId: boardId as BoardId,
});
const editor = { addFiles: () => {} } as unknown as ExcalidrawImperativeAPI;

const ready = (key: string): ReadyBoardView => ({
  status: "ready",
  board: {
    ...target(key),
    sceneFormatVersion: 1,
    revision: 0,
    orderRevision: 0,
    createdAt: "2026-11-24T00:00:00.000Z",
    updatedAt: "2026-11-24T00:00:00.000Z",
  },
  elements: [],
  settings: { viewBackgroundColor: "#ffffff" },
  files: [],
  changed: "all",
  mutationId: null,
});

const retryingEditor = () => ({
  addFiles: vi.fn(),
  getFiles: () => ({}),
  getSceneElementsIncludingDeleted: (): ReadonlyArray<ExcalidrawElement> => [],
  updateScene: vi.fn(),
});

describe("boardController", () => {
  it("frees a closed, saved board once another board opens, but keeps an open one", () => {
    const open = boardController("open", target("open"));
    open.attach(editor);
    const closed = boardController("closed", target("closed"));
    closed.attach(editor);
    closed.detach();

    boardController("next", target("next"));

    expect(boardController("open", target("open"))).toBe(open);
    expect(boardController("closed", target("closed"))).not.toBe(closed);
  });

  it("hydrates images after a transient failure without another board event", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const board = boardController("hydrate", target("hydrate"));
    const api = retryingEditor();
    const file = { id: "image", mimeType: "image/png", dataURL: "data:image/png;base64,AA==" };
    const addFiles = api.addFiles.mockImplementation(() => {
      api.getFiles = () => ({ [file.id]: file });
    });
    command
      .mockReset()
      .mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail(new Error("disconnected")) })
      .mockResolvedValueOnce({ _tag: "Success", value: [file] });
    try {
      const view = {
        ...ready("hydrate"),
        files: [
          { id: file.id, mimeType: "image/png" as const, size: 1, digest: "digest", created: 1 },
        ],
      };
      board.initialScene(view);
      board.attach(api as unknown as ExcalidrawImperativeAPI);
      await Promise.resolve();
      await vi.runOnlyPendingTimersAsync();
      expect(command).toHaveBeenCalledTimes(2);
      expect(addFiles).toHaveBeenCalledExactlyOnceWith([{ ...file, created: 1 }]);
    } finally {
      board.detach();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("retries a failed storage write with the original mutation id", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const board = boardController("retry-write", target("retry-write"));
    const api = retryingEditor();
    command
      .mockReset()
      .mockResolvedValueOnce({
        _tag: "Failure",
        cause: Cause.fail({ _tag: "BoardStorageError" }),
        error: { _tag: "BoardStorageError" },
      })
      .mockResolvedValueOnce({
        _tag: "Success",
        value: { revision: 1, orderRevision: 0, elements: [] },
      });
    try {
      board.initialScene(ready("retry-write"));
      board.attach(api as unknown as ExcalidrawImperativeAPI);
      board.onChange(
        [],
        {
          cursorButton: "up",
          newElement: null,
          multiElement: null,
          editingTextElement: null,
          viewBackgroundColor: "#000000",
        } as AppState,
        {},
        { composing: false, canEdit: true },
      );
      await vi.runOnlyPendingTimersAsync();
      expect(board.getSaveState()).toBe("retrying");
      await vi.runOnlyPendingTimersAsync();
      expect(command).toHaveBeenCalledTimes(2);
      expect(command.mock.calls[1]?.[2]).toEqual(command.mock.calls[0]?.[2]);
      expect(board.getRejection()).toBeNull();
      expect(board.getSaveState()).toBe("saved");
    } finally {
      board.detach();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it.each(["omitted", "tombstoned"])(
    "reports a rejected deletion with the element %s and offers no copy",
    async (representation) => {
      vi.useFakeTimers();
      vi.stubGlobal("window", globalThis);
      const board = boardController("delete-conflict", target("delete-conflict"));
      const api = retryingEditor();
      const error = { _tag: "BoardConflictError" };
      command
        .mockReset()
        .mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail(error), error });
      try {
        let elements: ReadonlyArray<ExcalidrawElement> = board.initialScene({
          ...ready("delete-conflict"),
          elements: [
            {
              id: "shape",
              type: "rectangle",
              index: "a0",
              version: 1,
              versionNonce: 1,
              isDeleted: false,
            },
          ],
        }).elements;
        api.getSceneElementsIncludingDeleted = () => elements;
        api.updateScene.mockImplementation(
          (scene: { elements?: ReadonlyArray<ExcalidrawElement> }) => {
            elements = scene.elements ?? elements;
          },
        );
        board.attach(api as unknown as ExcalidrawImperativeAPI);
        elements =
          representation === "omitted"
            ? []
            : elements.map((element) => ({ ...element, version: 2, isDeleted: true }));
        board.onChange(
          elements,
          {
            cursorButton: "up",
            newElement: null,
            multiElement: null,
            editingTextElement: null,
            viewBackgroundColor: "#ffffff",
          } as AppState,
          {},
          { composing: false, canEdit: true },
        );
        await vi.runOnlyPendingTimersAsync();
        expect(command.mock.calls[0]?.[2]).toMatchObject({
          input: { operations: [{ type: "delete", id: "shape" }] },
        });
        expect(elements[0]?.isDeleted).toBe(false);
        expect(board.getRejection()).toEqual({ kind: "conflict", canKeepCopy: false });
        board.discardRejected();
        expect(board.getRejection()).toBeNull();
      } finally {
        board.detach();
        vi.unstubAllGlobals();
        vi.useRealTimers();
      }
    },
  );
});
