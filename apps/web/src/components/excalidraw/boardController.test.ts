import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { BoardId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@excalidraw/excalidraw", () => ({
  CaptureUpdateAction: { IMMEDIATELY: "IMMEDIATELY", NEVER: "NEVER" },
  restoreElements: (elements: unknown) => elements,
}));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/board", () => ({ boardEnvironment: {} }));

const { boardController } = await import("./boardController");

const target = (boardId: string) => ({
  environmentId: "env" as EnvironmentId,
  threadId: "thread" as ThreadId,
  boardId: boardId as BoardId,
});
const editor = { addFiles: () => {} } as unknown as ExcalidrawImperativeAPI;

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
});
