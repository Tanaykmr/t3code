import { Excalidraw, defaultLang, languages } from "@excalidraw/excalidraw";
import type {
  ExcalidrawInitialDataState,
  ExcalidrawProps,
  LibraryItems,
} from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { useLocale } from "gt-react";
import { useRef, useState } from "react";
import { useTheme } from "../../hooks/useTheme";
import { useEnvironmentScope } from "../../state/session";

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

type SceneDraft = {
  elements: Parameters<NonNullable<ExcalidrawProps["onChange"]>>[0];
  files: NonNullable<ExcalidrawInitialDataState["files"]>;
  appState: { viewBackgroundColor: string };
};

const drafts = new Map<string, SceneDraft>();

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
  const threadKey = scopedThreadKey(threadRef);
  const { resolvedTheme } = useTheme();
  const langCode = editorLanguage(useLocale());
  const canEdit = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const composing = useRef(false);
  const [initialData] = useState<ExcalidrawInitialDataState>(() => {
    const libraryItems = readLibrary();
    const draft = drafts.get(threadKey);
    return {
      ...structuredClone(draft),
      ...(libraryItems ? { libraryItems } : {}),
      scrollToContent: draft !== undefined,
    };
  });

  const capture: NonNullable<ExcalidrawProps["onChange"]> = (elements, appState, files) => {
    if (
      !canEdit ||
      composing.current ||
      appState.cursorButton === "down" ||
      appState.newElement ||
      appState.multiElement ||
      appState.editingTextElement ||
      appState.isResizing ||
      appState.isRotating
    ) {
      return;
    }
    const previous = drafts.get(threadKey);
    const { viewBackgroundColor } = appState;
    const previousElements = previous?.elements ?? [];
    const previousFiles = previous?.files ?? {};
    const fileIds = Object.keys(files);
    if (
      (previous?.appState.viewBackgroundColor ?? "#ffffff") === viewBackgroundColor &&
      previousElements.length === elements.length &&
      elements.every((element, index) => {
        const prior = previousElements[index];
        return (
          prior?.id === element.id &&
          prior.version === element.version &&
          prior.versionNonce === element.versionNonce &&
          prior.index === element.index
        );
      }) &&
      Object.keys(previousFiles).length === fileIds.length &&
      fileIds.every((id) => previousFiles[id]?.dataURL === files[id]?.dataURL)
    ) {
      return;
    }
    drafts.set(threadKey, structuredClone({ elements, appState: { viewBackgroundColor }, files }));
  };

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
        initialData={initialData}
        theme={resolvedTheme}
        langCode={langCode}
        viewModeEnabled={!canEdit}
        handleKeyboardGlobally={false}
        validateEmbeddable={false}
        onChange={capture}
        onLibraryChange={(items) => {
          try {
            window.localStorage.setItem(LIBRARY_KEY, JSON.stringify(items));
          } catch {
            // Retain the editor's in-memory library if storage is blocked or full.
          }
        }}
      />
    </div>
  );
}
