import { CaptureUpdateAction, restoreElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { BoardView } from "@t3tools/client-runtime/state/board";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  BOARD_GET_FILES_MAX,
  type BoardElement,
  type BoardId,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";

import { randomUUID } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { boardEnvironment } from "../../state/board";
import {
  acknowledge,
  copyWithFreshIds,
  createBoardSession,
  editorStamp,
  hasUnsavedWork,
  markApplied,
  observeEditor,
  reconcile,
  rejectPending,
  seedScene,
  takeBatch,
} from "./boardSync";

export type ReadyBoardView = Extract<BoardView, { status: "ready" }>;
export type SaveState = "saved" | "saving" | "retrying" | "conflict" | "rejected";

interface BoardTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly boardId: BoardId;
}

const RETRY_MS = 2_000;
const COALESCE_MS = 150;

const asEditorElements = (elements: ReadonlyArray<BoardElement>) =>
  restoreElements(elements as unknown as ExcalidrawElement[], null, {
    refreshDimensions: false,
    repairBindings: false,
  });

/** Ids an unfinished gesture or text edit is changing, or null when nothing is in progress. */
function gestureIds(
  appState: AppState,
  composing: boolean,
  elements: ReadonlyArray<ExcalidrawElement>,
): ReadonlySet<string> | null {
  const active =
    composing ||
    appState.cursorButton === "down" ||
    appState.newElement !== null ||
    appState.multiElement !== null ||
    appState.editingTextElement !== null ||
    appState.isResizing ||
    appState.isRotating;
  if (!active) return null;
  const ids = new Set(
    [
      ...Object.keys(appState.selectedElementIds),
      appState.newElement?.id,
      appState.multiElement?.id,
      appState.editingTextElement?.id,
    ].filter((id) => id !== undefined),
  );
  // Dragging a shape also moves its labels and attached arrows, a frame moves its children,
  // and an arrow's ends move with it, so those records are part of the gesture too.
  for (const element of elements) {
    if (element.frameId !== null && ids.has(element.frameId)) ids.add(element.id);
  }
  for (const element of elements) {
    if (!ids.has(element.id)) continue;
    for (const bound of element.boundElements ?? []) ids.add(bound.id);
    if ("startBinding" in element && element.startBinding) ids.add(element.startBinding.elementId);
    if ("endBinding" in element && element.endBinding) ids.add(element.endBinding.elementId);
  }
  return ids;
}

/**
 * Bridges one board to the imperative editor. It outlives the mounted editor, so a closed panel
 * keeps unsaved drafts and an unacknowledged batch keeps its mutation id for retry.
 */
export class BoardController {
  private readonly session = createBoardSession();
  private api: ExcalidrawImperativeAPI | null = null;
  private view: ReadyBoardView | null = null;
  private held: ReadonlySet<string> = new Set();
  /** The editor's image bytes, kept so unsent images still save after the panel closes. */
  private files: BinaryFiles = {};
  private readonly fetching = new Set<string>();
  private flushTimer: number | null = null;
  private retryTimer: number | null = null;
  /** True while a batch is on the wire, so a stream update cannot send it a second time. */
  private sending = false;
  private saveState: SaveState = "saved";
  private readonly listeners = new Set<() => void>();

  constructor(private readonly target: BoardTarget) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSaveState = () => this.saveState;

  /** Closed, fully saved, and with no rejected edit waiting for the user. */
  isIdle() {
    return (
      this.api === null && !this.sending && this.rejection === null && !hasUnsavedWork(this.session)
    );
  }

  /** A rejected draft waiting for Keep as copy or Discard; later saves do not clear it. */
  private rejection: "conflict" | "rejected" | null = null;
  readonly getRejection = () => this.rejection;

  private setRejection(next: "conflict" | "rejected" | null) {
    if (next === this.rejection) return;
    this.rejection = next;
    for (const listener of this.listeners) listener();
  }

  private setSaveState(next: SaveState) {
    if (next === this.saveState) return;
    this.saveState = next;
    for (const listener of this.listeners) listener();
  }

  /** The scene a newly mounted editor starts from: committed records under local drafts. */
  initialScene(view: ReadyBoardView) {
    const { session } = this;
    this.view = view;
    const seed = seedScene(session, {
      revision: view.board.revision,
      elements: view.elements,
      orderRevision: view.board.orderRevision,
      viewBackgroundColor: view.settings.viewBackgroundColor,
    });
    const elements = asEditorElements(seed.elements);
    const stamps = new Map(elements.map((element) => [element.id, editorStamp(element)]));
    markApplied(session, seed.canonical, stamps, view.board);
    for (const record of seed.acknowledged) {
      session.baseline.set(record.id, stamps.get(record.id) ?? editorStamp(record));
    }
    // Until the stream reaches our own background commit, the acknowledged color is current.
    if (view.board.revision >= session.backgroundRevision || session.shownBackground === null) {
      session.shownBackground = view.settings.viewBackgroundColor;
    }
    return {
      elements,
      viewBackgroundColor:
        session.draftBackground ??
        session.pending?.settings?.viewBackgroundColor ??
        session.shownBackground,
    };
  }

  readonly attach = (api: ExcalidrawImperativeAPI) => {
    this.api = api;
    // Images saved locally but not yet sent come back with the remounted editor.
    const cached = Object.values(this.files).filter((file) => file !== undefined);
    if (cached.length > 0) api.addFiles(cached);
    this.sync();
    if (hasUnsavedWork(this.session) && this.flushTimer === null) this.send();
  };

  detach() {
    this.api = null;
    this.held = new Set();
    if (this.flushTimer === null) return;
    window.clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.send();
  }

  setView(view: ReadyBoardView) {
    this.view = view;
    this.sync();
  }

  onChange(
    elements: ReadonlyArray<ExcalidrawElement>,
    appState: AppState,
    files: BinaryFiles,
    input: { readonly composing: boolean; readonly canEdit: boolean },
  ) {
    // A remounted editor starts without the bytes of images that are still unsent.
    this.files = { ...this.files, ...files };
    const gesture = gestureIds(appState, input.composing, elements);
    const wasHeld = this.held.size > 0;
    this.held = gesture ?? new Set();
    if (gesture !== null || this.api === null) return;
    const edited =
      input.canEdit &&
      observeEditor(
        this.session,
        elements as ReadonlyArray<BoardElement>,
        appState.viewBackgroundColor,
      );
    // A change to drafts can release records that were held behind them.
    if (wasHeld || edited) this.showCanonical();
    // A draft waiting for its image bytes goes out once the editor has loaded them.
    const waiting =
      !edited && this.session.pending === null && this.session.drafts.size > 0 && input.canEdit;
    if (!edited && !waiting) return;
    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      this.send();
    }, COALESCE_MS);
  }

  keepRejectedAsCopy() {
    const { api, session } = this;
    if (api === null || session.rejected === null) return;
    const copies = asEditorElements(copyWithFreshIds(session.rejected, randomUUID));
    session.rejected = null;
    this.setRejection(null);
    api.updateScene({
      elements: [...api.getSceneElementsIncludingDeleted(), ...copies],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    this.setSaveState(hasUnsavedWork(session) ? "saving" : "saved");
  }

  discardRejected() {
    this.session.rejected = null;
    this.setRejection(null);
    this.setSaveState(hasUnsavedWork(this.session) ? "saving" : "saved");
  }

  private sync() {
    if (this.api === null || this.view === null) return;
    this.showCanonical();
    this.loadFiles();
    if (this.session.pending !== null && this.retryTimer === null && !this.sending) this.send();
  }

  private showCanonical() {
    const { api, view, session } = this;
    if (api === null || view === null) return;
    const next = reconcile(
      session,
      {
        revision: view.board.revision,
        elements: view.elements,
        orderRevision: view.board.orderRevision,
        viewBackgroundColor: view.settings.viewBackgroundColor,
      },
      api.getSceneElementsIncludingDeleted(),
      this.held,
    );
    const background = view.settings.viewBackgroundColor;
    // While our own color is saving, the stream's older color must not replace it.
    const backgroundChanged =
      session.draftBackground === null &&
      session.pending?.settings === undefined &&
      session.shownBackground !== background &&
      view.board.revision >= session.backgroundRevision;
    if (next === null && !backgroundChanged) return;
    const restored = new Map(
      asEditorElements(next?.applied ?? []).map((element) => [element.id, element]),
    );
    api.updateScene({
      ...(next === null
        ? {}
        : {
            elements: next.elements.map(
              (element) => restored.get(element.id) ?? (element as ExcalidrawElement),
            ),
          }),
      ...(backgroundChanged ? { appState: { viewBackgroundColor: background } } : {}),
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    if (backgroundChanged) session.shownBackground = background;
    if (next !== null) {
      const versions = new Map(
        api.getSceneElementsIncludingDeleted().map((element) => [element.id, editorStamp(element)]),
      );
      markApplied(session, next.applied, versions, view.board);
    }
  }

  private loadFiles() {
    const { api, view } = this;
    if (api === null || view === null) return;
    const loaded = api.getFiles();
    const missing = view.files
      .filter((ref) => !loaded[ref.id] && !this.fetching.has(ref.id))
      .slice(0, BOARD_GET_FILES_MAX);
    if (missing.length === 0) return;
    for (const ref of missing) this.fetching.add(ref.id);
    const created = new Map(missing.map((ref) => [ref.id, ref.created]));
    void runAtomCommand(
      appAtomRegistry,
      boardEnvironment.getFiles,
      {
        environmentId: this.target.environmentId,
        input: {
          threadId: this.target.threadId,
          boardId: this.target.boardId,
          fileIds: missing.map((ref) => ref.id),
        },
      },
      { reportFailure: false },
    ).then((files) => {
      for (const ref of missing) this.fetching.delete(ref.id);
      if (files._tag !== "Success" || this.api === null) return;
      this.api.addFiles(
        files.value.map((file): BinaryFileData => ({
          id: file.id as BinaryFileData["id"],
          dataURL: file.dataURL as BinaryFileData["dataURL"],
          mimeType: file.mimeType,
          created: created.get(file.id) ?? Date.now(),
        })),
      );
      this.loadFiles();
    });
  }

  private send() {
    const { session, view } = this;
    if (view === null || this.sending) return;
    let committed: Map<string, BoardElement> | undefined;
    const batch =
      session.pending ??
      takeBatch(session, {
        committedFileIds: new Set(view.files.map((file) => file.id)),
        editorFiles: { ...this.files, ...this.api?.getFiles() },
        mutationId: randomUUID(),
        committedRecord: (id) =>
          (committed ??= new Map(view.elements.map((e) => [e.id, e]))).get(id),
      });
    if (batch === null) {
      // Drafts that cannot go yet, such as an image whose bytes are still loading, wait for
      // the next edit or reopen.
      if (!hasUnsavedWork(session)) this.files = {};
      this.setSaveState(hasUnsavedWork(session) ? "retrying" : "saved");
      return;
    }
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.sending = true;
    this.setSaveState("saving");
    void runAtomCommand(
      appAtomRegistry,
      boardEnvironment.apply,
      {
        environmentId: this.target.environmentId,
        input: {
          threadId: this.target.threadId,
          boardId: this.target.boardId,
          mutationId: batch.mutationId,
          operations: batch.operations,
          ...(batch.expectedOrderRevision === undefined
            ? {}
            : { expectedOrderRevision: batch.expectedOrderRevision }),
          ...(batch.settings === undefined ? {} : { settings: batch.settings }),
          ...(batch.files.length === 0 ? {} : { files: batch.files }),
        },
      },
      { reportFailure: false },
    ).then((outcome) => {
      this.sending = false;
      if (session.pending?.mutationId !== batch.mutationId) return;
      if (outcome._tag === "Success") {
        acknowledge(session, outcome.value);
        this.showCanonical();
        this.send();
        return;
      }
      const failure = squashAtomCommandFailure(outcome);
      const tag =
        failure !== null && typeof failure === "object" && "_tag" in failure ? failure._tag : null;
      const permanent =
        (typeof tag === "string" && tag.startsWith("Board")) ||
        tag === "EnvironmentAuthorizationError" ||
        Cause.hasDies(outcome.cause);
      if (permanent) {
        const contributed = rejectPending(session);
        this.showCanonical();
        const kind = tag === "BoardConflictError" ? "conflict" : "rejected";
        if (contributed) this.setRejection(kind);
        this.setSaveState(kind);
        return;
      }
      // The receipt may have been lost after commit, so the same mutation id is retried.
      this.setSaveState("retrying");
      this.retryTimer = window.setTimeout(() => this.send(), RETRY_MS);
    });
  }
}

const controllers = new Map<string, BoardController>();

export function boardController(key: string, target: BoardTarget): BoardController {
  let controller = controllers.get(key);
  if (controller === undefined) {
    // Boards closed with nothing left to save are dropped so their scenes and images are freed.
    for (const [other, existing] of controllers) if (existing.isIdle()) controllers.delete(other);
    controller = new BoardController(target);
    controllers.set(key, controller);
  }
  return controller;
}
