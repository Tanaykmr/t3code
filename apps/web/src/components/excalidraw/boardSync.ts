import {
  BOARD_BATCH_MAX_BYTES,
  BOARD_BATCH_MAX_FILES,
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
export interface Receipt extends ShownRecord {
  readonly revision: number;
  /** The record as sent, shown until the stream delivers the canonical one. */
  readonly record: BoardElement;
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
  /** Image files committed by our own batches, before the stream lists them. */
  readonly uploadedFiles: Set<string>;
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
    uploadedFiles: new Set(),
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
    const queued = session.drafts.get(element.id);
    const deleting = session.pending?.sent.get(element.id)?.draft.type === TOMBSTONE;
    if (!element.isDeleted && (queued?.type === TOMBSTONE || (deleting && queued === undefined))) {
      // A record an import dropped came back. With its deletion in flight it is restored once
      // that lands; otherwise the queued deletion is cancelled. Either way it keeps its fence.
      const started = session.draftOrderRevision.get(element.id) ?? session.shownOrderRevision;
      session.drafts.delete(element.id);
      session.draftOrderRevision.delete(element.id);
      if (deleting || session.baseline.get(element.id) !== editorStamp(element)) {
        session.drafts.set(element.id, JSON.parse(JSON.stringify(element)) as BoardElement);
        session.draftOrderRevision.set(element.id, started);
      }
      changed = true;
      continue;
    }
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
    if (present.has(id) || basis(session, id) !== undefined || draft.type === TOMBSTONE) continue;
    if (session.pending?.sent.has(id)) {
      // A create in flight becomes a deletion once its receipt gives it a token.
      session.drafts.set(id, {
        id,
        type: TOMBSTONE,
        version: draft.version + 1,
        versionNonce: draft.versionNonce,
        index: draft.index,
        isDeleted: true,
      });
    } else {
      // A create that never reached the server just disappears with the editor's copy.
      session.drafts.delete(id);
      session.draftOrderRevision.delete(id);
    }
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
  // A color in flight is the basis, so reverting to the old one while it saves is an edit.
  const basisBackground = session.pending?.settings?.viewBackgroundColor ?? session.shownBackground;
  const background =
    viewBackgroundColor === (basisBackground ?? viewBackgroundColor) ? null : viewBackgroundColor;
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

// Soft batch sizes that keep ordinary saves small; a related group may exceed them.
const SOFT_OPERATIONS = 500;
const SOFT_ELEMENT_BYTES = 4 * 1024 * 1024;
const SOFT_TOTAL_BYTES = 20 * 1024 * 1024;
// Under the server's payload cap, with room for the batch envelope.
const HARD_TOTAL_BYTES = BOARD_BATCH_MAX_BYTES - 1024 * 1024;

/** Ids an element is linked to: its container, labels, frame, and bound shapes or arrows. */
const linksOf = (element: BoardElement | undefined): ReadonlyArray<string> => {
  if (element === undefined) return [];
  const links: string[] = [];
  for (const key of ["containerId", "frameId"]) {
    const value = element[key];
    if (typeof value === "string") links.push(value);
  }
  for (const key of ["startBinding", "endBinding"]) {
    const binding = element[key];
    if (binding !== null && typeof binding === "object" && "elementId" in binding) {
      links.push(String(binding.elementId));
    }
  }
  const bound = element["boundElements"];
  if (Array.isArray(bound)) {
    for (const entry of bound) {
      if (entry !== null && typeof entry === "object" && "id" in entry)
        links.push(String(entry.id));
    }
  }
  return links;
};

/**
 * Drafts grouped into connected components by links in the draft or its pre-edit record.
 * Union-find makes cycles (from malformed records) one group instead of leaving them unsent.
 * Groups are ordered by their first draft, so the result is deterministic.
 */
function connectedDrafts(
  session: BoardSession,
  committedRecord: ((id: string) => BoardElement | undefined) | undefined,
): ReadonlyArray<ReadonlyArray<[string, BoardElement]>> {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  for (const id of session.drafts.keys()) parent.set(id, id);
  // Members of one native group move together, so they save together too.
  const firstInGroup = new Map<string, string>();
  for (const [id, draft] of session.drafts) {
    const previous = session.receipts.get(id)?.record ?? committedRecord?.(id);
    for (const linked of [...linksOf(draft), ...linksOf(previous)]) {
      if (parent.has(linked)) parent.set(find(linked), find(id));
    }
    for (const record of [draft, previous]) {
      const groupIds = record?.["groupIds"];
      if (!Array.isArray(groupIds)) continue;
      for (const group of groupIds) {
        const first = firstInGroup.get(String(group));
        if (first === undefined) firstInGroup.set(String(group), id);
        else parent.set(find(first), find(id));
      }
    }
  }
  const groups = new Map<string, Array<[string, BoardElement]>>();
  for (const entry of session.drafts) {
    const root = find(entry[0]);
    const members = groups.get(root);
    if (members === undefined) groups.set(root, [entry]);
    else members.push(entry);
  }
  return [...groups.values()];
}
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
    /** The committed record, for tombstone sizes and links the drafts no longer carry. */
    readonly committedRecord?: (id: string) => BoardElement | undefined;
  },
): PendingBatch | null {
  if (session.pending !== null) return null;
  const operations: BoardOperation[] = [];
  const files: BoardFileData[] = [];
  const sent = new Map<string, { readonly draft: BoardElement; readonly isDeleted: boolean }>();
  let fence: number | undefined;
  let elementBytes = 0;
  let totalBytes = 0;
  // Related records — a container and its label, a frame and its children, an arrow and the
  // shapes it binds — go in one batch, which the server commits atomically, so no batch
  // boundary can split them. Links count from the draft and from the pre-edit record, so an
  // edit that just removed one (unbinding, clearing) still keeps the pair together.
  const groups = connectedDrafts(session, input.committedRecord);
  const sizeOf = (id: string, element: BoardElement) => {
    const receipt = session.receipts.get(id);
    const committed = input.committedRecord?.(id);
    return element.isDeleted && basis(session, id) !== undefined
      ? utf8Bytes(JSON.stringify(receipt?.record ?? committed ?? element))
      : utf8Bytes(JSON.stringify(element));
  };
  for (const group of groups) {
    // The soft limits only split unrelated groups across batches; a group always goes whole,
    // and the server's hard caps are the board's own, so it always fits.
    const groupBytes = group.reduce((total, [id, element]) => total + sizeOf(id, element), 0);
    if (
      operations.length > 0 &&
      (operations.length + group.length > SOFT_OPERATIONS ||
        elementBytes + groupBytes > SOFT_ELEMENT_BYTES ||
        totalBytes + groupBytes > SOFT_TOTAL_BYTES)
    ) {
      break;
    }
    // A group's new image bytes go with it. Bytes still loading hold the whole group back;
    // bytes that do not fit one batch are uploaded first, on their own, so the group's
    // records still commit together.
    const needed = [
      ...new Set(
        group.flatMap(([, element]) =>
          isImage(element) &&
          !element.isDeleted &&
          !input.committedFileIds.has(element.fileId) &&
          !session.uploadedFiles.has(element.fileId) &&
          !files.some((entry) => entry.id === element.fileId)
            ? [element.fileId]
            : [],
        ),
      ),
    ];
    const neededFiles = needed.map((fileId) => ({ fileId, file: input.editorFiles[fileId] }));
    if (neededFiles.some(({ file }) => file === undefined)) continue;
    const neededBytes = neededFiles.reduce((total, { file }) => total + file!.dataURL.length, 0);
    if (
      files.length + neededFiles.length > BOARD_BATCH_MAX_FILES ||
      totalBytes + groupBytes + neededBytes > HARD_TOTAL_BYTES
    ) {
      if (operations.length === 0 && files.length === 0) {
        for (const { fileId, file } of neededFiles) {
          if (files.length >= BOARD_BATCH_MAX_FILES) break;
          if (files.length > 0 && totalBytes + file!.dataURL.length > HARD_TOTAL_BYTES) break;
          totalBytes += file!.dataURL.length;
          files.push({
            id: fileId,
            mimeType: file!.mimeType as BoardFileMimeType,
            dataURL: file!.dataURL,
          });
        }
      }
      break;
    }
    for (const { fileId, file } of neededFiles) {
      totalBytes += file!.dataURL.length;
      files.push({
        id: fileId,
        mimeType: file!.mimeType as BoardFileMimeType,
        dataURL: file!.dataURL,
      });
    }
    for (const [id, element] of group) {
      const size = sizeOf(id, element);
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
        if (element.isDeleted && !shown.isDeleted)
          operations.push({ type: "delete", id, expected });
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
  }
  const settings =
    session.draftBackground === null ? undefined : { viewBackgroundColor: session.draftBackground };
  if (operations.length === 0 && settings === undefined && files.length === 0) return null;
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
      record: { ...sent.draft, index: accepted.index },
    });
    session.baseline.set(accepted.id, editorStamp(sent.draft));
    // Only the exact draft that was sent is done; a newer one, even at the same version, waits.
    if (session.drafts.get(accepted.id) === sent.draft) {
      session.drafts.delete(accepted.id);
      session.draftOrderRevision.delete(accepted.id);
    }
  }
  // When our commit alone moved the order by one, drafts that started from the order just
  // before it now continue from ours.
  const based = result.previousOrderRevision ?? pending.expectedOrderRevision;
  if (based !== undefined && result.orderRevision === based + 1) {
    for (const [id, started] of session.draftOrderRevision) {
      if (started === based) session.draftOrderRevision.set(id, result.orderRevision);
    }
    if (session.shownOrderRevision === based) session.shownOrderRevision = result.orderRevision;
  }
  for (const file of pending.files) session.uploadedFiles.add(file.id);
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
export function rejectPending(session: BoardSession): boolean {
  const pending = session.pending;
  if (pending === null) return false;
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
  if (pending.settings !== undefined) {
    // The editor may still show the rejected color; forgetting the shown one re-applies the
    // committed color instead of saving the rejected one on the next observation.
    session.draftBackground = null;
    session.shownBackground = null;
  }
  // An earlier rejection still waiting for Keep as copy or Discard is kept; a newer draft of
  // the same record supersedes it, so a copy never gets two records with one id.
  const unresolved = new Map((session.rejected ?? []).map((record) => [record.id, record]));
  for (const record of rejected) unresolved.set(record.id, record);
  session.rejected = unresolved.size > 0 ? [...unresolved.values()] : null;
  session.pending = null;
  return rejected.length > 0;
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
  const committed = new Set(canonical.elements.map((record) => record.id));
  for (const id of session.discard) {
    if (held.has(id)) continue;
    session.discard.delete(id);
    // Another editor committed this id first; its record replaces ours, it is not removed.
    if (committed.has(id)) continue;
    discarded = next.delete(id) || discarded;
  }
  if (applied.length === 0 && !discarded) return null;
  return { elements: [...next.values()].toSorted(order), applied };
}

/**
 * The scene a remounted editor starts from: the snapshot, our acknowledged records the stream
 * has not delivered yet, and unsent drafts, in drawing order. Records it marks as already
 * synced are the canonical ones and our own receipts, so mounting writes nothing.
 */
export function seedScene(
  session: BoardSession,
  canonical: CanonicalScene,
): {
  readonly elements: ReadonlyArray<BoardElement>;
  readonly canonical: ReadonlyArray<BoardElement>;
  readonly acknowledged: ReadonlyArray<BoardElement>;
} {
  const byId = new Map(canonical.elements.map((element) => [element.id, element]));
  const acknowledged: BoardElement[] = [];
  for (const [id, receipt] of session.receipts) {
    if (canonical.revision >= receipt.revision || session.drafts.has(id)) continue;
    byId.set(id, receipt.record);
    acknowledged.push(receipt.record);
  }
  for (const [id, draft] of session.drafts) {
    if (draft.type === TOMBSTONE) byId.delete(id);
    else byId.set(id, draft);
  }
  const fresh = new Set([...acknowledged.map((record) => record.id), ...session.drafts.keys()]);
  return {
    elements: [...byId.values()].toSorted(order),
    canonical: canonical.elements.filter((element) => !fresh.has(element.id)),
    acknowledged,
  };
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
  const ids = new Map(
    elements.filter((element) => !element.isDeleted).map((element) => [element.id, freshId()]),
  );
  const remap = (id: unknown) => (typeof id === "string" ? (ids.get(id) ?? id) : id);
  // Copies form their own groups, so selecting them never reaches the originals.
  const groups = new Map<string, string>();
  const remapGroup = (group: string) => {
    let fresh = groups.get(group);
    if (fresh === undefined) {
      fresh = freshId();
      groups.set(group, fresh);
    }
    return fresh;
  };
  // A binding to a shape outside the copy is dropped; that shape would not bind back to it.
  const remapBinding = (binding: unknown) =>
    binding !== null && typeof binding === "object" && "elementId" in binding
      ? ids.has(String(binding.elementId))
        ? { ...binding, elementId: remap(binding.elementId) }
        : null
      : binding;
  return elements
    .filter((element) => !element.isDeleted)
    .map((element): BoardElement => {
      const copy = structuredClone(element);
      const bound = copy["boundElements"];
      return {
        ...copy,
        id: ids.get(element.id)!,
        ...(Array.isArray(copy["groupIds"])
          ? { groupIds: copy["groupIds"].map((group: unknown) => remapGroup(String(group))) }
          : {}),
        ...(typeof copy["frameId"] === "string" && ids.has(copy["frameId"])
          ? { frameId: remap(copy["frameId"]) }
          : {}),
        ...("containerId" in copy
          ? {
              containerId: ids.has(String(copy["containerId"])) ? remap(copy["containerId"]) : null,
            }
          : {}),
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
