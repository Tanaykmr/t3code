import {
  BOARD_BATCH_MAX_FILES,
  BOARD_MAX_OPERATIONS,
  type BoardApplyResult,
  type BoardElement,
  type BoardElementToken,
  type BoardFileData,
  type BoardFileMimeType,
  type BoardOperation,
  type BoardSettings,
} from "@t3tools/contracts";

/** The canonical record an editor element was last synced from. */
export interface ShownRecord extends BoardElementToken {
  readonly isDeleted: boolean;
  readonly index: string | null;
}

export interface PendingBatch {
  readonly mutationId: string;
  readonly expectedOrderRevision: number | undefined;
  readonly operations: ReadonlyArray<BoardOperation>;
  readonly settings: BoardSettings | undefined;
  readonly files: ReadonlyArray<BoardFileData>;
  /** Editor version of each record as sent. */
  readonly sent: ReadonlyMap<string, number>;
}

/**
 * One editor's view of one board, kept outside the mounted editor so a closed panel keeps its
 * unsaved drafts and an in-flight batch keeps its mutation id for retry.
 */
export interface BoardSession {
  readonly shown: Map<string, ShownRecord>;
  /** Editor version last synced per id; any other version is a local edit. */
  readonly baseline: Map<string, number>;
  /** Unacknowledged local records, copied by value because the editor mutates its own. */
  readonly drafts: Map<string, BoardElement>;
  shownBackground: string | null;
  draftBackground: string | null;
  shownOrderRevision: number;
  pending: PendingBatch | null;
  rejected: ReadonlyArray<BoardElement> | null;
  /** Local-only ids the editor must drop after a rejection. */
  readonly discard: Set<string>;
}

export function createBoardSession(): BoardSession {
  return {
    shown: new Map(),
    baseline: new Map(),
    drafts: new Map(),
    shownBackground: null,
    draftBackground: null,
    shownOrderRevision: 0,
    pending: null,
    rejected: null,
    discard: new Set(),
  };
}

export function hasUnsavedWork(session: BoardSession): boolean {
  return session.drafts.size > 0 || session.draftBackground !== null || session.pending !== null;
}

/** Records completed local edits. Returns whether anything new needs saving. */
export function observeEditor(
  session: BoardSession,
  elements: ReadonlyArray<BoardElement>,
  viewBackgroundColor: string,
): boolean {
  let changed = false;
  for (const element of elements) {
    if (session.baseline.get(element.id) === element.version) continue;
    const draft = session.drafts.get(element.id);
    if (draft?.version === element.version && draft.versionNonce === element.versionNonce) continue;
    // JSON drops the editor's `undefined` fields, which the wire format cannot carry.
    session.drafts.set(element.id, JSON.parse(JSON.stringify(element)) as BoardElement);
    changed = true;
  }
  const background =
    viewBackgroundColor === (session.shownBackground ?? viewBackgroundColor)
      ? null
      : viewBackgroundColor;
  if (background !== session.draftBackground) {
    session.draftBackground = background;
    changed = true;
  }
  return changed;
}

const isImage = (element: BoardElement): element is BoardElement & { readonly fileId: string } =>
  element.type === "image" && typeof element["fileId"] === "string";

/** Builds the next batch from the drafts, or null when nothing is ready to send. */
export function takeBatch(
  session: BoardSession,
  input: {
    readonly committedFileIds: ReadonlySet<string>;
    readonly editorFiles: Readonly<
      Record<string, { readonly mimeType: string; readonly dataURL: string } | undefined>
    >;
    readonly mutationId: string;
  },
): PendingBatch | null {
  if (session.pending !== null) return null;
  const operations: BoardOperation[] = [];
  const files: BoardFileData[] = [];
  const sent = new Map<string, number>();
  let reordered = false;
  for (const [id, element] of session.drafts) {
    // Larger edits go out over several batches; the rest stay drafts for the next one.
    if (operations.length >= BOARD_MAX_OPERATIONS) break;
    const shown = session.shown.get(id);
    if (shown === undefined) {
      if (element.isDeleted) {
        session.drafts.delete(id);
        session.baseline.set(id, element.version);
        continue;
      }
      operations.push({ type: "create", element });
    } else {
      const expected = { version: shown.version, versionNonce: shown.versionNonce };
      if (element.isDeleted && !shown.isDeleted) operations.push({ type: "delete", id, expected });
      else if (!element.isDeleted && shown.isDeleted)
        operations.push({ type: "restore", element, expected });
      else operations.push({ type: "replace", element, expected });
      if (element.index !== shown.index) reordered = true;
    }
    sent.set(id, element.version);
    if (isImage(element) && !element.isDeleted && !input.committedFileIds.has(element.fileId)) {
      const file = input.editorFiles[element.fileId];
      if (
        file !== undefined &&
        files.length < BOARD_BATCH_MAX_FILES &&
        !files.some((entry) => entry.id === element.fileId)
      ) {
        files.push({
          id: element.fileId,
          mimeType: file.mimeType as BoardFileMimeType,
          dataURL: file.dataURL,
        });
      }
    }
  }
  const settings =
    session.draftBackground === null ? undefined : { viewBackgroundColor: session.draftBackground };
  if (operations.length === 0 && settings === undefined) return null;
  session.pending = {
    mutationId: input.mutationId,
    expectedOrderRevision: reordered ? session.shownOrderRevision : undefined,
    operations,
    settings,
    files,
    sent,
  };
  return session.pending;
}

/** Applies a receipt: later edits to the same records extend the accepted tokens. */
export function acknowledge(session: BoardSession, result: BoardApplyResult): void {
  const pending = session.pending;
  if (pending === null) return;
  for (const accepted of result.elements) {
    const sentVersion = pending.sent.get(accepted.id);
    const draft = session.drafts.get(accepted.id);
    session.shown.set(accepted.id, {
      version: accepted.version,
      versionNonce: accepted.versionNonce,
      index: accepted.index,
      isDeleted: draft?.isDeleted ?? false,
    });
    if (sentVersion === undefined) continue;
    session.baseline.set(accepted.id, sentVersion);
    if (draft?.version === sentVersion) session.drafts.delete(accepted.id);
  }
  if (pending.settings !== undefined) {
    session.shownBackground = pending.settings.viewBackgroundColor;
    if (session.draftBackground === pending.settings.viewBackgroundColor) {
      session.draftBackground = null;
    }
  }
  session.shownOrderRevision = Math.max(session.shownOrderRevision, result.orderRevision);
  session.pending = null;
}

/**
 * A conflicting batch is set aside whole, because its records may depend on each other. The
 * editor goes back to the committed scene and the draft stays available as a copy.
 */
export function rejectPending(session: BoardSession): void {
  const pending = session.pending;
  if (pending === null) return;
  const rejected: BoardElement[] = [];
  for (const id of pending.sent.keys()) {
    const draft = session.drafts.get(id);
    if (draft !== undefined) rejected.push(draft);
    session.drafts.delete(id);
    session.baseline.delete(id);
    if (session.shown.has(id)) session.shown.delete(id);
    else session.discard.add(id);
  }
  if (pending.settings !== undefined) session.draftBackground = null;
  session.rejected = rejected.length > 0 ? rejected : null;
  session.pending = null;
}

export interface CanonicalScene {
  readonly elements: ReadonlyArray<BoardElement>;
  readonly orderRevision: number;
  readonly viewBackgroundColor: string;
}

const order = (
  left: { readonly id: string; readonly index: string | null },
  right: typeof left,
) => {
  const a = left.index ?? "";
  const b = right.index ?? "";
  if (a !== b) return a < b ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
};

/**
 * The complete ordered scene to show, since the editor replaces its whole element array, or null
 * when the editor already shows everything it may. Records with local drafts or under an active
 * gesture keep their local copy until that work finishes.
 */
export function reconcile<T extends { readonly id: string; readonly index: string | null }>(
  session: BoardSession,
  canonical: CanonicalScene,
  editor: ReadonlyArray<T>,
  held: ReadonlySet<string>,
): {
  readonly elements: ReadonlyArray<T | BoardElement>;
  readonly applied: ReadonlyArray<BoardElement>;
} | null {
  const applied: BoardElement[] = [];
  const next = new Map<string, T | BoardElement>(editor.map((element) => [element.id, element]));
  for (const record of canonical.elements) {
    const shown = session.shown.get(record.id);
    if (shown?.version === record.version && shown.versionNonce === record.versionNonce) continue;
    if (session.drafts.has(record.id) || held.has(record.id)) continue;
    next.set(record.id, record);
    applied.push(record);
  }
  let discarded = false;
  for (const id of session.discard) {
    if (held.has(id)) continue;
    discarded = next.delete(id) || discarded;
    session.discard.delete(id);
  }
  if (applied.length === 0 && !discarded) return null;
  return { elements: [...next.values()].toSorted(order), applied };
}

/** Records what the editor holds after an inbound apply, so it never echoes back as an edit. */
export function markApplied(
  session: BoardSession,
  applied: ReadonlyArray<BoardElement>,
  editorVersions: ReadonlyMap<string, number>,
  canonical: Pick<CanonicalScene, "orderRevision">,
): void {
  for (const record of applied) {
    session.shown.set(record.id, {
      version: record.version,
      versionNonce: record.versionNonce,
      index: record.index,
      isDeleted: record.isDeleted,
    });
    session.baseline.set(record.id, editorVersions.get(record.id) ?? record.version);
  }
  session.shownOrderRevision = canonical.orderRevision;
}

/** Copies a rejected draft under fresh ids, rewriting references between the copied records. */
export function copyWithFreshIds(
  elements: ReadonlyArray<BoardElement>,
  freshId: () => string,
): BoardElement[] {
  const ids = new Map(elements.map((element) => [element.id, freshId()]));
  const remap = (id: unknown) => (typeof id === "string" ? (ids.get(id) ?? id) : id);
  const remapBinding = (binding: unknown) =>
    binding !== null && typeof binding === "object" && "elementId" in binding
      ? { ...binding, elementId: remap(binding.elementId) }
      : binding;
  return elements
    .filter((element) => !element.isDeleted)
    .map((element): BoardElement => {
      const copy = structuredClone(element);
      const bound = copy["boundElements"];
      return {
        ...copy,
        id: ids.get(element.id)!,
        ...("containerId" in copy ? { containerId: remap(copy["containerId"]) } : {}),
        ...("startBinding" in copy ? { startBinding: remapBinding(copy["startBinding"]) } : {}),
        ...("endBinding" in copy ? { endBinding: remapBinding(copy["endBinding"]) } : {}),
        ...(Array.isArray(bound)
          ? {
              boundElements: bound
                .filter((entry: { id?: unknown }) => ids.has(String(entry.id)))
                .map((entry: { id?: unknown }) => ({ ...entry, id: remap(entry.id) })),
            }
          : {}),
      };
    });
}
