import {
  BOARD_BATCH_MAX_BYTES,
  BOARD_BATCH_MAX_ELEMENT_BYTES,
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
  /** Each record as sent: the draft itself and whether it was a deletion. */
  readonly sent: ReadonlyMap<string, { readonly draft: BoardElement; readonly isDeleted: boolean }>;
}

/** A committed edit of ours whose canonical record the stream has not delivered yet. */
interface Receipt extends ShownRecord {
  readonly revision: number;
}

/**
 * One editor's view of one board, kept outside the mounted editor so a closed panel keeps its
 * unsaved drafts and an in-flight batch keeps its mutation id for retry.
 */
export interface BoardSession {
  readonly shown: Map<string, ShownRecord>;
  /** Editor version last synced per id; any other version is a local edit. */
  readonly baseline: Map<string, string>;
  /** Unacknowledged local records, copied by value because the editor mutates its own. */
  readonly drafts: Map<string, BoardElement>;
  /** Order revision each draft started from, so a reorder is fenced by what the user saw. */
  readonly draftOrderRevision: Map<string, number>;
  readonly receipts: Map<string, Receipt>;
  shownBackground: string | null;
  draftBackground: string | null;
  /** Revision of our last background commit; older stream values must not roll it back. */
  backgroundRevision: number;
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
    draftOrderRevision: new Map(),
    receipts: new Map(),
    shownBackground: null,
    draftBackground: null,
    backgroundRevision: 0,
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
  const present = new Set<string>();
  for (const element of elements) {
    present.add(element.id);
    if (session.baseline.get(element.id) === editorStamp(element)) continue;
    const draft = session.drafts.get(element.id);
    if (draft?.version === element.version && draft.versionNonce === element.versionNonce) continue;
    if (draft === undefined) session.draftOrderRevision.set(element.id, session.shownOrderRevision);
    // JSON drops the editor's `undefined` fields, which the wire format cannot carry.
    session.drafts.set(element.id, JSON.parse(JSON.stringify(element)) as BoardElement);
    changed = true;
  }
  // Opening a file replaces the editor's scene; records it dropped are deletions.
  for (const [id, draft] of session.drafts) {
    // A create that never reached the server just disappears with the editor's copy.
    if (present.has(id) || basis(session, id) !== undefined || draft.type === TOMBSTONE) continue;
    if (session.pending?.sent.has(id)) continue;
    session.drafts.delete(id);
    session.draftOrderRevision.delete(id);
    changed = true;
  }
  for (const id of new Set([...session.shown.keys(), ...session.receipts.keys()])) {
    const known = basis(session, id);
    if (known === undefined || known.isDeleted || present.has(id)) continue;
    if (session.drafts.get(id)?.isDeleted) continue;
    session.drafts.set(id, { id, type: TOMBSTONE, ...base(session, id, known), isDeleted: true });
    session.draftOrderRevision.set(id, session.shownOrderRevision);
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

/** An editor record's version pair; an import can change content without changing version. */
export const editorStamp = (element: {
  readonly version: number;
  readonly versionNonce: number;
}): string => `${element.version}:${element.versionNonce}`;

/** Placeholder for a record the editor dropped; it is only ever sent as a delete. */
const TOMBSTONE = "deleted";

const base = (session: BoardSession, id: string, shown: ShownRecord) => ({
  version: shown.version + 1,
  versionNonce: shown.versionNonce,
  index: shown.index,
});

/** The record a new edit is based on: our own unconfirmed receipt, else what the editor shows. */
const basis = (session: BoardSession, id: string): ShownRecord | undefined =>
  session.receipts.get(id) ?? session.shown.get(id);

// Headroom under the server's caps for the batch envelope and JSON escaping.
const ELEMENT_BUDGET = BOARD_BATCH_MAX_ELEMENT_BYTES - 64 * 1024;
const TOTAL_BUDGET = BOARD_BATCH_MAX_BYTES - 256 * 1024;
const encoder = new TextEncoder();
const utf8Bytes = (text: string) => encoder.encode(text).length;

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
    /** Serialized size of a committed record, which the server stores again as a tombstone. */
    readonly committedBytes?: (id: string) => number;
  },
): PendingBatch | null {
  if (session.pending !== null) return null;
  const operations: BoardOperation[] = [];
  const files: BoardFileData[] = [];
  const sent = new Map<string, { readonly draft: BoardElement; readonly isDeleted: boolean }>();
  let fence: number | undefined;
  let elementBytes = 0;
  let totalBytes = 0;
  for (const [id, element] of session.drafts) {
    // Larger edits go out over several batches; the rest stay drafts for the next one.
    if (operations.length >= BOARD_MAX_OPERATIONS) break;
    const size =
      element.isDeleted && basis(session, id) !== undefined
        ? (input.committedBytes?.(id) ?? utf8Bytes(JSON.stringify(element)))
        : utf8Bytes(JSON.stringify(element));
    if (
      operations.length > 0 &&
      (elementBytes + size > ELEMENT_BUDGET || totalBytes + size > TOTAL_BUDGET)
    ) {
      continue;
    }
    // An image travels with its bytes, or waits until they are loaded and the batch has room.
    if (isImage(element) && !element.isDeleted && !input.committedFileIds.has(element.fileId)) {
      if (!files.some((entry) => entry.id === element.fileId)) {
        const file = input.editorFiles[element.fileId];
        if (file === undefined || files.length >= BOARD_BATCH_MAX_FILES) continue;
        if (operations.length > 0 && totalBytes + size + file.dataURL.length > TOTAL_BUDGET) {
          continue;
        }
        totalBytes += file.dataURL.length;
        files.push({
          id: element.fileId,
          mimeType: file.mimeType as BoardFileMimeType,
          dataURL: file.dataURL,
        });
      }
    }
    const shown = basis(session, id);
    const settled = element.type === TOMBSTONE && (shown === undefined || shown.isDeleted);
    if (shown === undefined || settled) {
      if (element.isDeleted) {
        session.drafts.delete(id);
        session.draftOrderRevision.delete(id);
        session.baseline.set(id, editorStamp(element));
        continue;
      }
      operations.push({ type: "create", element });
    } else {
      const expected = { version: shown.version, versionNonce: shown.versionNonce };
      if (element.isDeleted && !shown.isDeleted) operations.push({ type: "delete", id, expected });
      else if (!element.isDeleted && shown.isDeleted)
        operations.push({ type: "restore", element, expected });
      else operations.push({ type: "replace", element, expected });
      if (!element.isDeleted && element.index !== shown.index) {
        const started = session.draftOrderRevision.get(id) ?? session.shownOrderRevision;
        fence = fence === undefined ? started : Math.min(fence, started);
      }
    }
    sent.set(id, { draft: element, isDeleted: element.isDeleted });
    elementBytes += size;
    totalBytes += size;
  }
  const settings =
    session.draftBackground === null ? undefined : { viewBackgroundColor: session.draftBackground };
  if (operations.length === 0 && settings === undefined) return null;
  session.pending = {
    mutationId: input.mutationId,
    expectedOrderRevision: fence,
    operations,
    settings,
    files,
    sent,
  };
  return session.pending;
}

/**
 * Applies a receipt. The editor keeps its local copy until the stream delivers the canonical
 * record, and later edits to the same records extend the accepted tokens.
 */
export function acknowledge(session: BoardSession, result: BoardApplyResult): void {
  const pending = session.pending;
  if (pending === null) return;
  for (const accepted of result.elements) {
    const sent = pending.sent.get(accepted.id);
    if (sent === undefined) continue;
    session.receipts.set(accepted.id, {
      version: accepted.version,
      versionNonce: accepted.versionNonce,
      index: accepted.index,
      isDeleted: sent.isDeleted,
      revision: result.revision,
    });
    session.baseline.set(accepted.id, editorStamp(sent.draft));
    // Only the exact draft that was sent is done; a newer one, even at the same version, waits.
    if (session.drafts.get(accepted.id) === sent.draft) {
      session.drafts.delete(accepted.id);
      session.draftOrderRevision.delete(accepted.id);
    }
  }
  // A fenced commit proves the order was ours and moved it by one, so drafts that started
  // from the same order now continue from ours.
  const based = pending.expectedOrderRevision;
  if (based !== undefined && result.orderRevision === based + 1) {
    for (const [id, started] of session.draftOrderRevision) {
      if (started === based) session.draftOrderRevision.set(id, result.orderRevision);
    }
    if (session.shownOrderRevision === based) session.shownOrderRevision = result.orderRevision;
  }
  if (pending.settings !== undefined) {
    session.backgroundRevision = result.revision;
    session.shownBackground = pending.settings.viewBackgroundColor;
    if (session.draftBackground === pending.settings.viewBackgroundColor) {
      session.draftBackground = null;
    }
  }
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
    if (draft !== undefined && draft.type !== "deleted") rejected.push(draft);
    session.drafts.delete(id);
    session.draftOrderRevision.delete(id);
    session.baseline.delete(id);
    session.receipts.delete(id);
    if (session.shown.has(id)) session.shown.delete(id);
    else session.discard.add(id);
  }
  if (pending.settings !== undefined) session.draftBackground = null;
  session.rejected = rejected.length > 0 ? rejected : null;
  session.pending = null;
}

export interface CanonicalScene {
  readonly revision: number;
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
    const receipt = session.receipts.get(record.id);
    if (receipt !== undefined) {
      // Until the stream reaches our commit, its older record must not roll the editor back.
      if (canonical.revision < receipt.revision) continue;
      // Under a gesture the receipt waits, so the canonical record is applied afterwards.
      if (held.has(record.id) && !session.drafts.has(record.id)) continue;
      session.receipts.delete(record.id);
      const ours =
        receipt.version === record.version && receipt.versionNonce === record.versionNonce;
      if (session.drafts.has(record.id)) {
        // A newer local edit continues from our record; a later remote change makes it stale.
        session.shown.set(record.id, ours ? toShown(record) : receipt);
        continue;
      }
    }
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

const toShown = (record: BoardElement): ShownRecord => ({
  version: record.version,
  versionNonce: record.versionNonce,
  index: record.index,
  isDeleted: record.isDeleted,
});

/** Records what the editor holds after an inbound apply, so it never echoes back as an edit. */
export function markApplied(
  session: BoardSession,
  applied: ReadonlyArray<BoardElement>,
  editorStamps: ReadonlyMap<string, string>,
  canonical: Pick<CanonicalScene, "orderRevision">,
): void {
  for (const record of applied) {
    session.shown.set(record.id, toShown(record));
    session.baseline.set(record.id, editorStamps.get(record.id) ?? editorStamp(record));
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
