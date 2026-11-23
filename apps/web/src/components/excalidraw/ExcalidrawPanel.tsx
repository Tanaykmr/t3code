import { useAtomValue } from "@effect/atom-react";
import { Excalidraw, defaultLang, languages } from "@excalidraw/excalidraw";
import type { LibraryItems } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { T, useGT, useLocale } from "gt-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTheme } from "../../hooks/useTheme";
import { boardEnvironment } from "../../state/board";
import { useServerConfigs } from "../../state/entities";
import { useConnectedEnvironmentIds } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { type ReadyBoardView, boardController } from "./boardController";

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string;
  }
}

window.EXCALIDRAW_ASSET_PATH = new URL(
  `${import.meta.env.BASE_URL}assets/excalidraw/`,
  window.location.href,
).href;

const LIBRARY_KEY = "t3code:excalidraw-library";

function readLibrary(): LibraryItems | undefined {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(LIBRARY_KEY) ?? "null");
    return Array.isArray(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

function editorLanguage(locale: string): string {
  const language = locale.split("-")[0];
  return (
    languages.find((entry) => entry.code === locale)?.code ??
    languages.find((entry) => entry.code.split("-")[0] === language)?.code ??
    defaultLang.code
  );
}

export function ExcalidrawPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const config = useServerConfigs().get(threadRef.environmentId);
  if (config === undefined) {
    return (
      <div role="status" className="p-4 text-sm text-muted-foreground">
        <T>Loading board…</T>
      </div>
    );
  }
  if (config.environment.capabilities.boards !== true) {
    return (
      <div role="status" className="p-4 text-sm text-muted-foreground">
        <T>Update this environment's T3 Code server to use boards.</T>
      </div>
    );
  }
  return <ThreadBoard threadRef={threadRef} />;
}

function ThreadBoard({ threadRef }: { threadRef: ScopedThreadRef }) {
  const { environmentId, threadId } = threadRef;
  const result = useAtomValue(boardEnvironment.view({ environmentId, input: { threadId } }));
  const canEdit = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const createBoard = useAtomCommand(boardEnvironment.create, { reportFailure: true });
  const view = AsyncResult.getOrElse(result, () => null);

  if (view === null) {
    return (
      <div role="status" className="p-4 text-sm text-muted-foreground">
        {result._tag === "Failure" ? <T>This board could not be loaded.</T> : <T>Loading board…</T>}
      </div>
    );
  }
  if (view.status === "missing") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
        <T>This thread has no board yet.</T>
        {canEdit ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void createBoard({ environmentId, input: { threadId } })}
          >
            <T>Create board</T>
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <BoardEditor
      key={`${scopedThreadKey(threadRef)}:${view.board.boardId}`}
      threadRef={threadRef}
      view={view}
      canEdit={canEdit}
    />
  );
}

function BoardEditor(props: {
  threadRef: ScopedThreadRef;
  view: ReadyBoardView;
  canEdit: boolean;
}) {
  const { threadRef, view, canEdit } = props;
  const { environmentId, threadId } = threadRef;
  const gt = useGT();
  const { resolvedTheme } = useTheme();
  const langCode = editorLanguage(useLocale());
  const online = useConnectedEnvironmentIds().includes(environmentId);
  const controller = boardController(`${scopedThreadKey(threadRef)}:${view.board.boardId}`, {
    environmentId,
    threadId,
    boardId: view.board.boardId,
  });
  const saveState = useSyncExternalStore(controller.subscribe, controller.getSaveState);
  const composing = useRef(false);
  const [initialData] = useState(() => {
    const scene = controller.initialScene(view);
    const libraryItems = readLibrary();
    return {
      elements: scene.elements,
      appState: { viewBackgroundColor: scene.viewBackgroundColor },
      scrollToContent: scene.elements.length > 0,
      ...(libraryItems ? { libraryItems } : {}),
    };
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Pushes committed board state into the imperative editor.
  useEffect(() => {
    controller.setView(view);
  }, [controller, view]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Releases the imperative editor when it unmounts.
  useEffect(() => () => controller.detach(), [controller]);

  const status = !online
    ? null
    : saveState === "saving"
      ? gt("Saving…")
      : saveState === "retrying"
        ? gt("Not saved yet · retrying")
        : saveState === "saved"
          ? gt("Saved")
          : null;

  return (
    <div
      className="relative min-h-0 min-w-0 flex-1"
      data-excalidraw-panel
      onCompositionStartCapture={() => {
        composing.current = true;
      }}
      onCompositionEndCapture={() => {
        composing.current = false;
      }}
    >
      <Excalidraw
        excalidrawAPI={controller.attach}
        initialData={initialData}
        theme={resolvedTheme}
        langCode={langCode}
        viewModeEnabled={!canEdit || !online}
        handleKeyboardGlobally={false}
        validateEmbeddable={false}
        onChange={(elements, appState, files) =>
          controller.onChange(elements, appState, files, { composing: composing.current, canEdit })
        }
        onLibraryChange={(items) => {
          try {
            window.localStorage.setItem(LIBRARY_KEY, JSON.stringify(items));
          } catch {
            // Retain the editor's in-memory library if storage is blocked or full.
          }
        }}
        renderTopRightUI={() =>
          status === null || !canEdit ? null : (
            <span role="status" className="self-center px-2 text-xs text-muted-foreground">
              {status}
            </span>
          )
        }
      />
      {!online && canEdit ? (
        <div
          role="status"
          className="pointer-events-none absolute inset-x-0 top-4 z-10 mx-auto w-fit rounded-md border bg-background px-3 py-1 text-xs text-muted-foreground"
        >
          <T>Offline · read-only</T>
        </div>
      ) : null}
      {saveState === "conflict" || saveState === "rejected" ? (
        <div
          role="alert"
          className="absolute inset-x-4 top-16 z-10 mx-auto flex max-w-md flex-wrap items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm shadow-sm"
        >
          <span className="min-w-0 flex-1">
            {saveState === "conflict" ? (
              <T>Someone changed this first. Your edit was not saved.</T>
            ) : (
              <T>This edit could not be saved.</T>
            )}
          </span>
          <Button variant="ghost" size="sm" onClick={() => controller.discardRejected()}>
            <T>Discard</T>
          </Button>
          <Button variant="outline" size="sm" onClick={() => controller.keepRejectedAsCopy()}>
            <T>Keep as copy</T>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
