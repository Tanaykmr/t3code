import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * A thread's Excalidraw board. Elements are native Excalidraw element JSON; the server reads only
 * the fields below and stores the rest untouched. See docs/architecture/excalidraw.md.
 */
export const BOARD_SCENE_FORMAT_VERSION = 1;
export const BOARD_MAX_OPERATIONS = 500;
export const BOARD_MAX_ELEMENTS = 5_000;
const utf8 = new TextEncoder();
const utf8Bytes = (text: string) => utf8.encode(text).length;
const BOARD_ELEMENT_MAX_BYTES = 256 * 1024;
export const BOARD_FILE_MAX_BYTES = 4 * 1024 * 1024;
export const BOARD_BATCH_MAX_FILES = 8;
/** Serialized size of one edit batch, files included. */
export const BOARD_BATCH_MAX_BYTES = 24 * 1024 * 1024;
export const BOARD_GET_FILES_MAX = 64;
/** Element JSON a board, or one edit batch, may hold; image bytes are counted separately. */
export const BOARD_MAX_ELEMENT_BYTES = 16 * 1024 * 1024;
export const BOARD_BATCH_MAX_ELEMENT_BYTES = 4 * 1024 * 1024;
/** Image bytes and files one board may hold; the snapshot lists every file. */
export const BOARD_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const BOARD_MAX_FILES = 512;
/** Image bytes one `getFiles` response may carry; the client asks again for the rest. */
export const BOARD_GET_FILES_MAX_BYTES = 12 * 1024 * 1024;

export const BoardId = TrimmedNonEmptyString.pipe(Schema.brand("BoardId"));
export type BoardId = typeof BoardId.Type;

const BoardElementId = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256));
const BoardFileId = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256));
const BoardMutationId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const BoardElement = Schema.StructWithRest(
  Schema.Struct({
    id: BoardElementId,
    type: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
    version: Schema.Int,
    versionNonce: Schema.Int,
    index: Schema.NullOr(Schema.String.check(Schema.isMaxLength(256))),
    isDeleted: Schema.Boolean,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
export type BoardElement = typeof BoardElement.Type;

/** Only proposals are size-checked; snapshots carry records the server already accepted. */
const BoardElementProposal = BoardElement.check(
  Schema.makeFilter((element) => utf8Bytes(JSON.stringify(element)) <= BOARD_ELEMENT_MAX_BYTES, {
    description: `an element of at most ${BOARD_ELEMENT_MAX_BYTES} bytes`,
  }),
);

export const BoardElementToken = Schema.Struct({
  version: Schema.Int,
  versionNonce: Schema.Int,
});
export type BoardElementToken = typeof BoardElementToken.Type;

/** Image types the editor accepts as embedded files. */
export const BoardFileMimeType = Schema.Literals([
  "image/png",
  "image/jpeg",
  "image/svg+xml",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/x-icon",
  "image/avif",
  "image/jfif",
]);
export type BoardFileMimeType = typeof BoardFileMimeType.Type;

export const BoardFileRef = Schema.Struct({
  id: BoardFileId,
  mimeType: BoardFileMimeType,
  size: NonNegativeInt,
  /** Hex SHA-256 of the bytes. */
  digest: Schema.String,
  /** Excalidraw's `created`, epoch milliseconds. */
  created: Schema.Int,
});
export type BoardFileRef = typeof BoardFileRef.Type;

export const BoardFileData = Schema.Struct({
  id: BoardFileId,
  mimeType: BoardFileMimeType,
  dataURL: Schema.String.check(Schema.isMaxLength(Math.ceil((BOARD_FILE_MAX_BYTES * 4) / 3) + 256)),
});
export type BoardFileData = typeof BoardFileData.Type;

export const BoardHeader = Schema.Struct({
  boardId: BoardId,
  threadId: ThreadId,
  sceneFormatVersion: Schema.Literal(BOARD_SCENE_FORMAT_VERSION),
  revision: NonNegativeInt,
  orderRevision: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BoardHeader = typeof BoardHeader.Type;

export const BoardSettings = Schema.Struct({
  viewBackgroundColor: Schema.String.check(Schema.isMaxLength(64)),
});
export type BoardSettings = typeof BoardSettings.Type;

export const BoardSnapshot = Schema.Struct({
  board: BoardHeader,
  /** Canonical order: by `(index, id)`, tombstones included. */
  elements: Schema.Array(BoardElement),
  settings: BoardSettings,
  files: Schema.Array(BoardFileRef),
});
export type BoardSnapshot = typeof BoardSnapshot.Type;

export const BoardOperation = Schema.Union([
  Schema.Struct({ type: Schema.Literal("create"), element: BoardElementProposal }),
  Schema.Struct({
    type: Schema.Literal("replace"),
    element: BoardElementProposal,
    expected: BoardElementToken,
  }),
  Schema.Struct({
    type: Schema.Literal("delete"),
    id: BoardElementId,
    expected: BoardElementToken,
  }),
  /** `expected` is the current tombstone's token. */
  Schema.Struct({
    type: Schema.Literal("restore"),
    element: BoardElementProposal,
    expected: BoardElementToken,
  }),
]);
export type BoardOperation = typeof BoardOperation.Type;

/**
 * Commits atomically. `operations` may be empty only when `settings` or `files` change. Files ride
 * inline so a file always belongs to the board it was committed with.
 */
export const BoardEditBatch = Schema.Struct({
  threadId: ThreadId,
  boardId: BoardId,
  mutationId: BoardMutationId,
  expectedOrderRevision: Schema.optional(NonNegativeInt),
  operations: Schema.Array(BoardOperation).check(Schema.isMaxLength(BOARD_MAX_OPERATIONS)),
  settings: Schema.optional(BoardSettings),
  files: Schema.optional(
    Schema.Array(BoardFileData).check(Schema.isMaxLength(BOARD_BATCH_MAX_FILES)),
  ),
});
export type BoardEditBatch = typeof BoardEditBatch.Type;

export const BoardDelta = Schema.Struct({
  boardId: BoardId,
  revision: NonNegativeInt,
  orderRevision: NonNegativeInt,
  mutationId: BoardMutationId,
  /** Canonical records this commit changed, including any whose index the server repaired. */
  elements: Schema.Array(BoardElement),
  settings: Schema.optional(BoardSettings),
  files: Schema.optional(Schema.Array(BoardFileRef)),
});
export type BoardDelta = typeof BoardDelta.Type;

export const BoardAcceptedElement = Schema.Struct({
  id: BoardElementId,
  version: Schema.Int,
  versionNonce: Schema.Int,
  index: Schema.NullOr(Schema.String),
});
export type BoardAcceptedElement = typeof BoardAcceptedElement.Type;

export const BoardApplyResult = Schema.Struct({
  revision: NonNegativeInt,
  orderRevision: NonNegativeInt,
  /** The order revision just before this commit, so an editor can step over its own change. */
  previousOrderRevision: Schema.optional(NonNegativeInt),
  elements: Schema.Array(BoardAcceptedElement),
});
export type BoardApplyResult = typeof BoardApplyResult.Type;

export const BoardGetInput = Schema.Struct({ threadId: ThreadId });
export type BoardGetInput = typeof BoardGetInput.Type;
export const BoardCreateInput = Schema.Struct({ threadId: ThreadId });
export type BoardCreateInput = typeof BoardCreateInput.Type;
export const BoardSubscribeInput = Schema.Struct({ threadId: ThreadId });
export type BoardSubscribeInput = typeof BoardSubscribeInput.Type;
export const BoardGetFilesInput = Schema.Struct({
  threadId: ThreadId,
  boardId: BoardId,
  fileIds: Schema.Array(BoardFileId).check(Schema.isMaxLength(BOARD_GET_FILES_MAX)),
});
export type BoardGetFilesInput = typeof BoardGetFilesInput.Type;

export const BoardStreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("missing") }),
  Schema.Struct({ type: Schema.Literal("snapshot"), snapshot: BoardSnapshot }),
  Schema.Struct({ type: Schema.Literal("delta"), delta: BoardDelta }),
]);
export type BoardStreamEvent = typeof BoardStreamEvent.Type;

export class BoardNotFoundError extends Schema.TaggedError<BoardNotFoundError>()(
  "BoardNotFoundError",
  {
    threadId: ThreadId,
    boardId: Schema.optional(BoardId),
  },
) {
  override get message(): string {
    return this.boardId === undefined
      ? "This thread does not exist in this environment."
      : "This board does not exist for this thread.";
  }
}

export const BoardConflict = Schema.Struct({
  id: BoardElementId,
  /** Null when no element has this id. */
  current: Schema.NullOr(BoardElementToken),
});
export type BoardConflict = typeof BoardConflict.Type;

export class BoardConflictError extends Schema.TaggedError<BoardConflictError>()(
  "BoardConflictError",
  {
    /** Empty when only the order revision was stale. */
    conflicts: Schema.Array(BoardConflict),
    orderRevision: NonNegativeInt,
  },
) {
  override get message(): string {
    return "The board changed before this edit was saved.";
  }
}

export class BoardMutationReuseError extends Schema.TaggedError<BoardMutationReuseError>()(
  "BoardMutationReuseError",
  { mutationId: BoardMutationId },
) {
  override get message(): string {
    return "This mutation id was already used for a different edit.";
  }
}

const BOARD_INVALID_BATCH_MESSAGES = {
  empty: "The edit changes nothing.",
  "duplicate-element": "The edit changes one element more than once.",
  "board-full": "The board is full.",
  "batch-too-large": "The edit is too large.",
  "file-invalid": "A file is not a supported image.",
  "file-too-large": "A file is too large.",
  "file-conflict": "A file id already holds different content.",
  "file-missing": "An image refers to a file this board does not have.",
  "invalid-version": "An element version is out of range.",
} as const;

export class BoardInvalidBatchError extends Schema.TaggedError<BoardInvalidBatchError>()(
  "BoardInvalidBatchError",
  {
    reason: Schema.Literals([
      "empty",
      "duplicate-element",
      "board-full",
      "batch-too-large",
      "file-invalid",
      "file-too-large",
      "file-conflict",
      "file-missing",
      "invalid-version",
    ]),
  },
) {
  override get message(): string {
    return BOARD_INVALID_BATCH_MESSAGES[this.reason];
  }
}

export class BoardStorageError extends Schema.TaggedError<BoardStorageError>()(
  "BoardStorageError",
  { operation: Schema.Literals(["read", "write"]) },
) {
  override get message(): string {
    return this.operation === "read" ? "Failed to read the board." : "Failed to save the board.";
  }
}

export const BoardReadError = Schema.Union([BoardNotFoundError, BoardStorageError]);
export type BoardReadError = typeof BoardReadError.Type;

export const BoardApplyError = Schema.Union([
  BoardNotFoundError,
  BoardConflictError,
  BoardMutationReuseError,
  BoardInvalidBatchError,
  BoardStorageError,
]);
export type BoardApplyError = typeof BoardApplyError.Type;
