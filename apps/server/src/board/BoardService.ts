// @effect-diagnostics nodeBuiltinImport:off - hashing file bytes and batch payloads.
import * as NodeCrypto from "node:crypto";

import {
  BOARD_BATCH_MAX_BYTES,
  BOARD_BATCH_MAX_ELEMENT_BYTES,
  BOARD_FILE_MAX_BYTES,
  BOARD_GET_FILES_MAX_BYTES,
  BOARD_MAX_ELEMENT_BYTES,
  BOARD_MAX_FILE_BYTES,
  BOARD_MAX_FILES,
  BOARD_MAX_ELEMENTS,
  BOARD_SCENE_FORMAT_VERSION,
  BoardApplyResult,
  BoardConflictError,
  BoardEditBatch,
  BoardElement,
  BoardId,
  BoardInvalidBatchError,
  BoardMutationReuseError,
  BoardNotFoundError,
  BoardStorageError,
  type BoardConflict,
  type BoardDelta,
  type BoardElementToken,
  type BoardFileData,
  BoardFileMimeType,
  type BoardFileRef,
  type BoardGetFilesInput,
  type BoardHeader,
  type BoardSettings,
  type BoardSnapshot,
  type BoardStreamEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import { generateKeyBetween } from "fractional-indexing";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

type BoardReadFailure = BoardNotFoundError | BoardStorageError;
type BoardApplyFailure =
  | BoardNotFoundError
  | BoardConflictError
  | BoardMutationReuseError
  | BoardInvalidBatchError
  | BoardStorageError;

export class BoardService extends Context.Service<
  BoardService,
  {
    /** The thread's board, or null when none was created. Never creates one. */
    readonly get: (threadId: ThreadId) => Effect.Effect<BoardSnapshot | null, BoardReadFailure>;
    /** Idempotent per owning thread. */
    readonly create: (threadId: ThreadId) => Effect.Effect<BoardHeader, BoardReadFailure>;
    /** `actor` scopes mutation receipts: the authenticated session or agent that sent the batch. */
    readonly apply: (input: {
      readonly actor: string;
      readonly batch: BoardEditBatch;
    }) => Effect.Effect<BoardApplyResult, BoardApplyFailure>;
    readonly getFiles: (
      input: BoardGetFilesInput,
    ) => Effect.Effect<ReadonlyArray<BoardFileData>, BoardReadFailure>;
    /** A `missing` or `snapshot` event, then committed changes in order. */
    readonly subscribe: (threadId: ThreadId) => Stream.Stream<BoardStreamEvent, BoardReadFailure>;
    /** Deletes the thread's board with its files and receipts, for permanent thread deletion. */
    readonly remove: (threadId: ThreadId) => Effect.Effect<void, BoardStorageError>;
  }
>()("t3/board/BoardService") {}

/** Boards belong to their thread. A project-shared board would change only this key. */
const boardOwnerKey = (threadId: ThreadId): string => threadId;

const DEFAULT_SETTINGS: BoardSettings = { viewBackgroundColor: "#ffffff" };
// A subscriber that falls this far behind sees a revision gap and reopens with a snapshot.
const SUBSCRIBER_BUFFER = 64;
// Leaves room below the largest safe integer for many stamped successors.
const MAX_PROPOSAL_VERSION = Number.MAX_SAFE_INTEGER - 2 ** 20;
const MAX_VERSION_NONCE = 2 ** 31;

interface BoardRow {
  readonly board_id: string;
  readonly thread_id: string;
  readonly revision: number;
  readonly order_revision: number;
  readonly view_background_color: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ElementRow {
  readonly element_id: string;
  readonly version: number;
  readonly version_nonce: number;
  readonly idx: string | null;
  readonly is_deleted?: number;
  readonly payload_json: string;
}

interface FileRefRow {
  readonly file_id: string;
  readonly mime_type: string;
  readonly size: number;
  readonly digest: string;
  readonly created: number;
}

const decodeElementJson = Schema.decodeUnknownSync(Schema.fromJsonString(BoardElement));
const decodeApplyResultJson = Schema.decodeUnknownEffect(Schema.fromJsonString(BoardApplyResult));
const encodeApplyResultJson = Schema.encodeEffect(Schema.fromJsonString(BoardApplyResult));
const encodeElementJson = Schema.encodeEffect(Schema.fromJsonString(BoardElement));
const encodeBatchJson = Schema.encodeEffect(Schema.fromJsonString(BoardEditBatch));
const isBoardInvalidBatchError = Schema.is(BoardInvalidBatchError);
const isBoardMimeType = Schema.is(BoardFileMimeType);

const toHeader = (row: BoardRow, threadId: ThreadId): BoardHeader => ({
  boardId: BoardId.make(row.board_id),
  threadId,
  sceneFormatVersion: BOARD_SCENE_FORMAT_VERSION,
  revision: row.revision,
  orderRevision: row.order_revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toFileRef = (row: FileRefRow): BoardFileRef | null =>
  isBoardMimeType(row.mime_type)
    ? {
        id: row.file_id,
        mimeType: row.mime_type,
        size: row.size,
        digest: row.digest,
        created: row.created,
      }
    : null;

const tokenOf = (row: ElementRow): BoardElementToken => ({
  version: row.version,
  versionNonce: row.version_nonce,
});

/** Excalidraw orders by plain string comparison of fractional indices. */
const compareIndex = (a: string | null, b: string | null): number => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
};

const compareCanonical = (
  a: { readonly id: string; readonly index: string | null },
  b: { readonly id: string; readonly index: string | null },
): number => compareIndex(a.index, b.index) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const isValidIndex = (index: string): boolean => {
  try {
    generateKeyBetween(index, null);
    return true;
  } catch {
    return false;
  }
};

/**
 * Gives every proposed element whose index is missing, invalid, or shared with another element a
 * fresh index between its neighbours. Committed elements keep theirs, so only this batch moves.
 */
const repairIndices = (
  committed: ReadonlyArray<{
    readonly id: string;
    readonly index: string | null;
    readonly containerId: string | null;
  }>,
  proposed: ReadonlyArray<BoardElement>,
): ReadonlyMap<string, string> => {
  const proposedIds = new Set(proposed.map((entry) => entry.id));
  const stable: Array<{ id: string; index: string; containerId: string | null }> = [];
  for (const entry of committed) {
    if (!proposedIds.has(entry.id) && entry.index !== null) {
      stable.push({ id: entry.id, index: entry.index, containerId: entry.containerId });
    }
  }
  const taken = new Set(stable.map((entry) => entry.index));
  const committedIndex = new Map(committed.map((entry) => [entry.id, entry.index]));
  // Existing elements keeping their index claim it first, so a create never displaces them.
  const keeps = (entry: BoardElement) =>
    entry.index !== null && committedIndex.get(entry.id) === entry.index;
  const ordered = [...proposed].toSorted(
    (left, right) => Number(keeps(right)) - Number(keeps(left)) || compareCanonical(left, right),
  );
  const needsRepair = new Set<string>();
  for (const entry of ordered) {
    if (entry.index !== null && isValidIndex(entry.index) && !taken.has(entry.index)) {
      taken.add(entry.index);
    } else {
      needsRepair.add(entry.id);
    }
  }
  // A bound label moves with a repaired container, and one below its container is lifted,
  // so the two stay adjacent with the label on top.
  const containerOf = (entry: BoardElement) =>
    typeof entry["containerId"] === "string" ? entry["containerId"] : null;
  const indexOf = new Map<string, string | null>([
    ...committed.map((entry) => [entry.id, entry.index] as const),
    ...proposed.map((entry) => [entry.id, entry.index] as const),
  ]);
  for (const entry of ordered) {
    const container = containerOf(entry);
    if (container === null) continue;
    const containerIndex = indexOf.get(container) ?? null;
    if (
      needsRepair.has(container) ||
      (containerIndex !== null && entry.index !== null && entry.index < containerIndex)
    ) {
      needsRepair.add(entry.id);
    }
  }
  for (const entry of ordered) {
    if (!needsRepair.has(entry.id) && entry.index !== null) {
      stable.push({ id: entry.id, index: entry.index, containerId: containerOf(entry) });
    }
  }
  stable.sort(compareCanonical);
  const repaired = new Map<string, string>();
  // Containers are placed before their labels so a label can always go right above one.
  const repairOrder = [...proposed]
    .toSorted(compareCanonical)
    .toSorted(
      (left, right) => Number(containerOf(left) !== null) - Number(containerOf(right) !== null),
    );
  for (const entry of repairOrder) {
    if (!needsRepair.has(entry.id)) continue;
    const container = containerOf(entry);
    const containerPosition =
      container === null ? -1 : stable.findIndex((candidate) => candidate.id === container);
    const anchor = entry.index !== null && isValidIndex(entry.index) ? entry.index : null;
    const above = stable.findIndex((candidate) => anchor !== null && candidate.index > anchor);
    // A label goes right above its container; anything else lands just above its proposed slot.
    let position =
      containerPosition !== -1
        ? containerPosition + 1
        : anchor === null || above === -1
          ? stable.length
          : above;
    // Never split another element from the bound labels directly above it.
    const splitsLabel = (at: number) => {
      const label = stable[at];
      return (
        label !== undefined &&
        label.containerId !== null &&
        stable.slice(0, at).some((candidate) => candidate.id === label.containerId)
      );
    };
    if (containerPosition === -1) {
      while (position > 0 && splitsLabel(position)) position += 1;
    }
    const index = generateKeyBetween(
      stable[position - 1]?.index ?? null,
      stable[position]?.index ?? null,
    );
    stable.splice(position, 0, { id: entry.id, index, containerId: container });
    repaired.set(entry.id, index);
  }
  return repaired;
};

const DATA_URL_PATTERN = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/;

const decodeFileUpload = (
  file: BoardFileData,
): { readonly bytes: Buffer; readonly digest: string } | BoardInvalidBatchError => {
  const match = DATA_URL_PATTERN.exec(file.dataURL);
  if (match === null || match[1] !== file.mimeType) {
    return new BoardInvalidBatchError({ reason: "file-invalid" });
  }
  const bytes = Buffer.from(match[2] ?? "", "base64");
  if (bytes.byteLength === 0) return new BoardInvalidBatchError({ reason: "file-invalid" });
  if (bytes.byteLength > BOARD_FILE_MAX_BYTES) {
    return new BoardInvalidBatchError({ reason: "file-too-large" });
  }
  return { bytes, digest: NodeCrypto.createHash("sha256").update(bytes).digest("hex") };
};

const sameToken = (row: ElementRow, expected: BoardElementToken) =>
  row.version === expected.version && row.version_nonce === expected.versionNonce;

const operationElementId = (operation: BoardEditBatch["operations"][number]) =>
  operation.type === "delete" ? operation.id : operation.element.id;

/** Delete needs a live element, restore a tombstone, and replace keeps the deleted state. */
const transitionAllowed = (
  operation: BoardEditBatch["operations"][number],
  currentlyDeleted: boolean,
): boolean => {
  switch (operation.type) {
    case "create":
      return true;
    case "delete":
      return !currentlyDeleted;
    case "restore":
      return currentlyDeleted;
    case "replace":
      return operation.element.isDeleted === currentlyDeleted;
  }
};

interface BoardChannel {
  readonly lock: Semaphore.Semaphore;
  readonly events: PubSub.PubSub<BoardStreamEvent>;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const random = yield* SecureRandom.SecureRandom;
  const channels = new Map<string, BoardChannel>();

  const channelFor = Effect.fnUntraced(function* (ownerKey: string) {
    const existing = channels.get(ownerKey);
    if (existing !== undefined) return existing;
    const events = yield* PubSub.sliding<BoardStreamEvent>(SUBSCRIBER_BUFFER);
    const raced = channels.get(ownerKey);
    if (raced !== undefined) return raced;
    const channel: BoardChannel = { lock: Semaphore.makeUnsafe(1), events };
    channels.set(ownerKey, channel);
    return channel;
  });

  const storage =
    (operation: "read" | "write") =>
    <A, R>(effect: Effect.Effect<A, SqlError.SqlError, R>) =>
      effect.pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Board storage failed").pipe(Effect.annotateLogs({ operation, cause })),
        ),
        Effect.mapError(() => new BoardStorageError({ operation })),
      );

  const requireThread = Effect.fn("BoardService.requireThread")(function* (threadId: ThreadId) {
    const titles = yield* projections
      .getThreadTitles([threadId])
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Board thread lookup failed").pipe(
            Effect.annotateLogs({ cause }),
            Effect.andThen(Effect.fail(new BoardStorageError({ operation: "read" }))),
          ),
        ),
      );
    if (!Object.hasOwn(titles, threadId)) return yield* new BoardNotFoundError({ threadId });
  });

  const findBoard = (ownerKey: string) =>
    sql<BoardRow>`
      SELECT board_id, thread_id, revision, order_revision, view_background_color, created_at,
        updated_at
      FROM board
      WHERE thread_id = ${ownerKey}
    `.pipe(Effect.map((rows) => rows[0] ?? null));

  const readSnapshot = (ownerKey: string, threadId: ThreadId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const board = yield* findBoard(ownerKey);
          if (board === null) return null;
          const elements = yield* sql<Pick<ElementRow, "payload_json">>`
            SELECT payload_json FROM board_element WHERE board_id = ${board.board_id}
          `;
          const files = yield* sql<FileRefRow>`
            SELECT file_id, mime_type, size, digest, created
            FROM board_file
            WHERE board_id = ${board.board_id}
          `;
          const snapshot: BoardSnapshot = {
            board: toHeader(board, threadId),
            elements: elements
              .map((row) => decodeElementJson(row.payload_json))
              .toSorted(compareCanonical),
            settings: { viewBackgroundColor: board.view_background_color },
            files: files.flatMap((row) => toFileRef(row) ?? []),
          };
          return snapshot;
        }),
      )
      .pipe(storage("read"));

  const get: BoardService["Service"]["get"] = Effect.fn("BoardService.get")(function* (threadId) {
    yield* Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": threadId });
    yield* requireThread(threadId);
    return yield* readSnapshot(boardOwnerKey(threadId), threadId);
  });

  const create: BoardService["Service"]["create"] = Effect.fn("BoardService.create")(
    function* (threadId) {
      yield* Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": threadId });
      const ownerKey = boardOwnerKey(threadId);
      const channel = yield* channelFor(ownerKey);
      return yield* Semaphore.withPermit(
        channel.lock,
        Effect.gen(function* () {
          // Checked under the lock so a create cannot land after the thread's board cleanup.
          yield* requireThread(threadId);
          const existing = yield* findBoard(ownerKey).pipe(storage("read"));
          if (existing !== null) return toHeader(existing, threadId);
          const boardId = yield* random.uuidV4();
          const now = DateTime.formatIso(yield* DateTime.now);
          const row: BoardRow = {
            board_id: boardId,
            thread_id: ownerKey,
            revision: 0,
            order_revision: 0,
            view_background_color: DEFAULT_SETTINGS.viewBackgroundColor,
            created_at: now,
            updated_at: now,
          };
          yield* sql`
            INSERT INTO board (board_id, thread_id, scene_format_version, revision, order_revision,
              view_background_color, created_at, updated_at)
            VALUES (${row.board_id}, ${row.thread_id}, ${BOARD_SCENE_FORMAT_VERSION}, 0, 0,
              ${row.view_background_color}, ${now}, ${now})
          `.pipe(
            storage("write"),
            // A committed board must reach subscribers that saw it missing.
            Effect.andThen(
              PubSub.publish(channel.events, {
                type: "snapshot",
                snapshot: {
                  board: toHeader(row, threadId),
                  elements: [],
                  settings: DEFAULT_SETTINGS,
                  files: [],
                },
              }),
            ),
            Effect.uninterruptible,
          );
          return toHeader(row, threadId);
        }),
      );
    },
  );

  const commit = Effect.fn("BoardService.commit")(function* (
    channel: BoardChannel,
    actor: string,
    batch: BoardEditBatch,
  ) {
    const ownerKey = boardOwnerKey(batch.threadId);
    const board = yield* findBoard(ownerKey).pipe(storage("read"));
    if (board === null || board.board_id !== batch.boardId) {
      return yield* new BoardNotFoundError({ threadId: batch.threadId, boardId: batch.boardId });
    }

    const payload = yield* encodeBatchJson(batch).pipe(Effect.orDie);
    if (Buffer.byteLength(payload) > BOARD_BATCH_MAX_BYTES) {
      return yield* new BoardInvalidBatchError({ reason: "batch-too-large" });
    }
    const payloadDigest = NodeCrypto.createHash("sha256").update(payload).digest("hex");
    const [receipt] = yield* sql<{
      readonly actor: string;
      readonly payload_digest: string;
      readonly result_json: string;
    }>`
      SELECT actor, payload_digest, result_json
      FROM board_mutation
      WHERE board_id = ${board.board_id} AND mutation_id = ${batch.mutationId}
    `.pipe(storage("read"));
    if (receipt !== undefined) {
      if (receipt.actor !== actor || receipt.payload_digest !== payloadDigest) {
        return yield* new BoardMutationReuseError({ mutationId: batch.mutationId });
      }
      return yield* decodeApplyResultJson(receipt.result_json).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.logWarning("Board receipt is unreadable").pipe(
              Effect.annotateLogs({ cause }),
              Effect.andThen(Effect.fail(new BoardStorageError({ operation: "read" }))),
            ),
        }),
      );
    }

    const files = batch.files ?? [];
    if (batch.operations.length === 0 && batch.settings === undefined && files.length === 0) {
      return yield* new BoardInvalidBatchError({ reason: "empty" });
    }
    const touchedIds = batch.operations.map(operationElementId);
    if (new Set(touchedIds).size !== touchedIds.length) {
      return yield* new BoardInvalidBatchError({ reason: "duplicate-element" });
    }

    const currentRows =
      touchedIds.length === 0
        ? []
        : yield* sql<ElementRow>`
            SELECT element_id, version, version_nonce, idx, is_deleted, payload_json
            FROM board_element
            WHERE board_id = ${board.board_id} AND element_id IN ${sql.in(touchedIds)}
          `.pipe(storage("read"));
    const current = new Map(currentRows.map((row) => [row.element_id, row]));
    // A proposal may sit just above the record it replaces; the stamp must stay a safe integer.
    const versionOutOfRange = batch.operations.some((operation) => {
      if (operation.type === "delete") {
        return (current.get(operation.id)?.version ?? 0) + 1 >= Number.MAX_SAFE_INTEGER;
      }
      const { version } = operation.element;
      const prior = current.get(operation.element.id)?.version ?? 0;
      const ceiling = Math.max(MAX_PROPOSAL_VERSION, prior + 1024);
      return (
        version < 0 || version > ceiling || Math.max(version, prior) >= Number.MAX_SAFE_INTEGER
      );
    });
    if (versionOutOfRange) {
      return yield* new BoardInvalidBatchError({ reason: "invalid-version" });
    }

    const conflicts: Array<BoardConflict> = [];
    for (const operation of batch.operations) {
      const id = operationElementId(operation);
      const row = current.get(id);
      if (operation.type === "create") {
        if (row !== undefined) conflicts.push({ id, current: tokenOf(row) });
      } else if (row === undefined) {
        conflicts.push({ id, current: null });
      } else if (!sameToken(row, operation.expected)) {
        conflicts.push({ id, current: tokenOf(row) });
      } else if (!transitionAllowed(operation, row.is_deleted === 1)) {
        // The caller's view of whether this element is deleted is out of date.
        conflicts.push({ id, current: tokenOf(row) });
      }
    }
    // Rearranging existing elements must say which order it was based on.
    const unfencedReorder =
      batch.expectedOrderRevision === undefined &&
      batch.operations.some(
        (operation) =>
          (operation.type === "restore" ||
            (operation.type === "replace" && !operation.element.isDeleted)) &&
          current.has(operation.element.id) &&
          current.get(operation.element.id)?.idx !== operation.element.index,
      );
    if (
      conflicts.length > 0 ||
      unfencedReorder ||
      (batch.expectedOrderRevision !== undefined &&
        batch.expectedOrderRevision !== board.order_revision)
    ) {
      return yield* new BoardConflictError({ conflicts, orderRevision: board.order_revision });
    }

    const createCount = batch.operations.filter((operation) => operation.type === "create").length;
    if (createCount > 0) {
      const [count] = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM board_element WHERE board_id = ${board.board_id}
      `.pipe(storage("read"));
      if ((count?.count ?? 0) + createCount > BOARD_MAX_ELEMENTS) {
        return yield* new BoardInvalidBatchError({ reason: "board-full" });
      }
    }

    // Restore stamps the record live whatever its payload says, so it is checked too.
    const referencedFileIds = batch.operations.flatMap((operation) => {
      if (operation.type === "delete") return [];
      if (operation.type !== "restore" && operation.element.isDeleted) return [];
      const fileId = operation.element["fileId"];
      return operation.element.type === "image" && typeof fileId === "string" ? [fileId] : [];
    });
    const fileIds = [...new Set([...files.map((file) => file.id), ...referencedFileIds])];
    const existingFiles =
      fileIds.length === 0
        ? []
        : yield* sql<{ readonly file_id: string; readonly digest: string }>`
            SELECT file_id, digest FROM board_file
            WHERE board_id = ${board.board_id} AND file_id IN ${sql.in(fileIds)}
          `.pipe(storage("read"));
    const knownDigests = new Map(existingFiles.map((row) => [row.file_id, row.digest]));
    const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
    const newFiles: Array<{ readonly ref: BoardFileRef; readonly bytes: Buffer }> = [];
    for (const file of files) {
      const decoded = decodeFileUpload(file);
      if (isBoardInvalidBatchError(decoded)) return yield* decoded;
      const known = knownDigests.get(file.id);
      if (known !== undefined) {
        if (known !== decoded.digest) {
          return yield* new BoardInvalidBatchError({ reason: "file-conflict" });
        }
        continue;
      }
      knownDigests.set(file.id, decoded.digest);
      newFiles.push({
        ref: {
          id: file.id,
          mimeType: file.mimeType,
          size: decoded.bytes.byteLength,
          digest: decoded.digest,
          created: nowMillis,
        },
        bytes: decoded.bytes,
      });
    }

    if (referencedFileIds.some((fileId) => !knownDigests.has(fileId))) {
      return yield* new BoardInvalidBatchError({ reason: "file-missing" });
    }
    if (newFiles.length > 0) {
      const [stored] = yield* sql<{ readonly total: number | null; readonly count: number }>`
        SELECT SUM(size) AS total, COUNT(*) AS count FROM board_file
        WHERE board_id = ${board.board_id}
      `.pipe(storage("read"));
      const added = newFiles.reduce((total, file) => total + file.ref.size, 0);
      if (
        (stored?.total ?? 0) + added > BOARD_MAX_FILE_BYTES ||
        (stored?.count ?? 0) + newFiles.length > BOARD_MAX_FILES
      ) {
        return yield* new BoardInvalidBatchError({ reason: "board-full" });
      }
    }

    const stamped: Array<BoardElement> = [];
    for (const operation of batch.operations) {
      const row = current.get(operationElementId(operation));
      const prior = row === undefined ? null : decodeElementJson(row.payload_json);
      const proposal = operation.type === "delete" ? prior : operation.element;
      if (proposal === null) continue;
      const versionNonce = yield* random.intBetween(0, MAX_VERSION_NONCE, { halfOpen: true });
      stamped.push({
        ...proposal,
        version:
          Math.max(prior?.version ?? 0, operation.type === "delete" ? 0 : proposal.version) + 1,
        versionNonce,
        isDeleted:
          operation.type === "delete"
            ? true
            : operation.type === "restore"
              ? false
              : proposal.isDeleted,
      });
    }

    const indexChanged = stamped.some(
      (element) => current.get(element.id)?.idx !== element.index || !current.has(element.id),
    );
    let changed = stamped;
    if (indexChanged) {
      const committed = yield* sql<{
        readonly element_id: string;
        readonly idx: string | null;
        readonly container_id: string | null;
      }>`
        SELECT element_id, idx, json_extract(payload_json, '$.containerId') AS container_id
        FROM board_element WHERE board_id = ${board.board_id}
      `.pipe(storage("read"));
      const repaired = repairIndices(
        committed.map((row) => ({
          id: row.element_id,
          index: row.idx,
          containerId: typeof row.container_id === "string" ? row.container_id : null,
        })),
        stamped,
      );
      changed = stamped.map((element) => {
        const index = repaired.get(element.id);
        return index === undefined ? element : { ...element, index };
      });
    }
    changed = changed.toSorted(compareCanonical);

    const revision = board.revision + 1;
    const orderRevision = indexChanged ? board.order_revision + 1 : board.order_revision;
    const settings = batch.settings;
    const result: BoardApplyResult = {
      revision,
      orderRevision,
      previousOrderRevision: board.order_revision,
      elements: changed.map((element) => ({
        id: element.id,
        version: element.version,
        versionNonce: element.versionNonce,
        index: element.index,
      })),
    };
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    const resultJson = yield* encodeApplyResultJson(result).pipe(Effect.orDie);
    const rows = yield* Effect.forEach(changed, (element) =>
      encodeElementJson(element).pipe(
        Effect.orDie,
        Effect.map((payloadJson) => ({ element, payloadJson })),
      ),
    );

    const [storedElements] = yield* sql<{ readonly total: number | null }>`
      SELECT SUM(LENGTH(CAST(payload_json AS BLOB))) AS total FROM board_element
      WHERE board_id = ${board.board_id}
    `.pipe(storage("read"));
    const replacedBytes = rows.reduce(
      (total, { element }) =>
        total + Buffer.byteLength(current.get(element.id)?.payload_json ?? ""),
      0,
    );
    const addedBytes = rows.reduce(
      (total, { payloadJson }) => total + Buffer.byteLength(payloadJson),
      0,
    );
    if (addedBytes > BOARD_BATCH_MAX_ELEMENT_BYTES) {
      return yield* new BoardInvalidBatchError({ reason: "batch-too-large" });
    }
    if ((storedElements?.total ?? 0) - replacedBytes + addedBytes > BOARD_MAX_ELEMENT_BYTES) {
      return yield* new BoardInvalidBatchError({ reason: "board-full" });
    }

    const delta: BoardDelta = {
      boardId: batch.boardId,
      revision,
      orderRevision,
      mutationId: batch.mutationId,
      elements: changed,
      ...(settings === undefined ? {} : { settings }),
      ...(newFiles.length === 0 ? {} : { files: newFiles.map((file) => file.ref) }),
    };
    // A durable receipt without a published delta would leave other editors stale.
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          for (const { element, payloadJson } of rows) {
            yield* sql`
              INSERT INTO board_element (board_id, element_id, version, version_nonce, idx,
                is_deleted, payload_json)
              VALUES (${board.board_id}, ${element.id}, ${element.version},
                ${element.versionNonce}, ${element.index}, ${element.isDeleted ? 1 : 0},
                ${payloadJson})
              ON CONFLICT (board_id, element_id) DO UPDATE SET
                version = excluded.version,
                version_nonce = excluded.version_nonce,
                idx = excluded.idx,
                is_deleted = excluded.is_deleted,
                payload_json = excluded.payload_json
            `;
          }
          for (const file of newFiles) {
            yield* sql`
              INSERT INTO board_file (board_id, file_id, mime_type, size, digest, created, bytes)
              VALUES (${board.board_id}, ${file.ref.id}, ${file.ref.mimeType}, ${file.ref.size},
                ${file.ref.digest}, ${file.ref.created}, ${new Uint8Array(file.bytes)})
            `;
          }
          yield* sql`
            UPDATE board SET
              revision = ${revision},
              order_revision = ${orderRevision},
              view_background_color = ${settings?.viewBackgroundColor ?? board.view_background_color},
              updated_at = ${updatedAt}
            WHERE board_id = ${board.board_id}
          `;
          yield* sql`
            INSERT INTO board_mutation (board_id, mutation_id, actor, payload_digest, result_json)
            VALUES (${board.board_id}, ${batch.mutationId}, ${actor}, ${payloadDigest},
              ${resultJson})
          `;
        }),
      )
      .pipe(
        storage("write"),
        Effect.andThen(PubSub.publish(channel.events, { type: "delta", delta })),
        Effect.uninterruptible,
      );
    return result;
  });

  const apply: BoardService["Service"]["apply"] = Effect.fn("BoardService.apply")(function* ({
    actor,
    batch,
  }) {
    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.thread_id": batch.threadId,
      "board.operations": batch.operations.length,
    });
    yield* requireThread(batch.threadId);
    const channel = yield* channelFor(boardOwnerKey(batch.threadId));
    return yield* Semaphore.withPermit(channel.lock, commit(channel, actor, batch));
  });

  const getFiles: BoardService["Service"]["getFiles"] = Effect.fn("BoardService.getFiles")(
    function* (input) {
      yield* Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId });
      yield* requireThread(input.threadId);
      const board = yield* findBoard(boardOwnerKey(input.threadId)).pipe(storage("read"));
      if (board === null || board.board_id !== input.boardId) {
        return yield* new BoardNotFoundError({ threadId: input.threadId, boardId: input.boardId });
      }
      if (input.fileIds.length === 0) return [];
      const sizes = yield* sql<{ readonly file_id: string; readonly size: number }>`
        SELECT file_id, size FROM board_file
        WHERE board_id = ${board.board_id} AND file_id IN ${sql.in([...input.fileIds])}
      `.pipe(storage("read"));
      // Always send at least one file; the client asks again for the ones left out.
      let budget = BOARD_GET_FILES_MAX_BYTES;
      const selected = sizes.flatMap((row, index) => {
        // Bytes travel as base64 inside the response.
        const encoded = Math.ceil(row.size / 3) * 4;
        if (index > 0 && encoded > budget) return [];
        budget -= encoded;
        return [row.file_id];
      });
      if (selected.length === 0) return [];
      const rows = yield* sql<{
        readonly file_id: string;
        readonly mime_type: string;
        readonly bytes: Uint8Array;
      }>`
        SELECT file_id, mime_type, bytes FROM board_file
        WHERE board_id = ${board.board_id} AND file_id IN ${sql.in(selected)}
      `.pipe(storage("read"));
      return rows.flatMap((row) =>
        isBoardMimeType(row.mime_type)
          ? [
              {
                id: row.file_id,
                mimeType: row.mime_type,
                dataURL: `data:${row.mime_type};base64,${Buffer.from(row.bytes).toString("base64")}`,
              },
            ]
          : [],
      );
    },
  );

  const subscribe: BoardService["Service"]["subscribe"] = (threadId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* requireThread(threadId);
        const ownerKey = boardOwnerKey(threadId);
        const channel = yield* channelFor(ownerKey);
        // Subscribing and reading under the commit lock means no commit falls between the two.
        const [subscription, snapshot] = yield* Semaphore.withPermit(
          channel.lock,
          Effect.all([PubSub.subscribe(channel.events), readSnapshot(ownerKey, threadId)]),
        );
        const initial: BoardStreamEvent =
          snapshot === null ? { type: "missing" } : { type: "snapshot", snapshot };
        return Stream.concat(Stream.make(initial), Stream.fromSubscription(subscription));
      }),
    );

  const remove: BoardService["Service"]["remove"] = Effect.fn("BoardService.remove")(
    function* (threadId) {
      const ownerKey = boardOwnerKey(threadId);
      const channel = yield* channelFor(ownerKey);
      yield* Semaphore.withPermit(
        channel.lock,
        Effect.gen(function* () {
          const board = yield* findBoard(ownerKey);
          if (board === null) return;
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`DELETE FROM board_element WHERE board_id = ${board.board_id}`;
                yield* sql`DELETE FROM board_file WHERE board_id = ${board.board_id}`;
                yield* sql`DELETE FROM board_mutation WHERE board_id = ${board.board_id}`;
                yield* sql`DELETE FROM board WHERE board_id = ${board.board_id}`;
              }),
            )
            .pipe(
              Effect.andThen(PubSub.publish(channel.events, { type: "missing" })),
              Effect.uninterruptible,
            );
        }).pipe(storage("write")),
      );
    },
  );

  return BoardService.of({ get, create, apply, getFiles, subscribe, remove });
});

export const layer = Layer.effect(BoardService, make);
