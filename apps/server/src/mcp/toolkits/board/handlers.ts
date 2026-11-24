import {
  BOARD_MAX_OPERATIONS,
  type BoardApplyError,
  type BoardReadError,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as BoardService from "../../../board/BoardService.ts";
import {
  type BoardSummaryElement,
  clipBoardSummary,
  compileBoardEdits,
  summarizeBoard,
} from "../../../board/BoardEdits.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller } from "../../threadAccess.ts";
import { BoardToolkit, boardEditConflict, type BoardGetResult } from "./tools.ts";

const DEFAULT_LIMIT = 200;
/** Encoded element JSON per board_get page, so one read stays small in the transcript. */
const PAGE_BYTES = 32_000;
const ID_BYTES = 15;
const SEED_BYTES = 4;
const MAX_SEED = 2 ** 31;

const toFailure = (error: BoardReadError | BoardApplyError) => {
  switch (error._tag) {
    case "BoardConflictError":
      return boardEditConflict(error.conflicts);
    case "BoardNotFoundError":
      return error.boardId === undefined
        ? new OrchestratorMcpFailure({ code: "thread_not_found", message: error.message })
        : new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "This thread has no board yet. Call board_create first.",
          });
    case "BoardInvalidBatchError":
      return new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });
    case "BoardMutationReuseError":
    case "BoardStorageError":
      return new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });
  }
};

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/** Only the calling thread's board: no tool takes a thread or board id. */
const callerThread = Effect.fn("BoardToolkit.callerThread")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "Board tools");
  return thread;
});

/** Plan mode reads the board but does not change it, like the workspace. */
const refusePlanMode = Effect.fn("BoardToolkit.refusePlanMode")(function* () {
  const { limits } = yield* loadCaller();
  if (limits.interactionMode === "plan") {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This thread is in plan mode: it can read the board with board_get, not change it.",
    });
  }
});

/** FNV-1a, enough to tell one board_get filter from another in a cursor. */
const filterKey = (ids: ReadonlyArray<string> | undefined, text: string | undefined) => {
  let hash = 0x811c9dc5;
  for (const char of JSON.stringify([ids ?? null, text ?? null])) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

const parseCursor = (cursor: string) => {
  const match = /^(\d+):(\d+):([0-9a-z]+)$/.exec(cursor);
  return match === null
    ? null
    : { revision: Number(match[1]), offset: Number(match[2]), filter: match[3]! };
};

/** Clipped elements from the front of `candidates`, at least one, up to PAGE_BYTES encoded. */
const page = (candidates: ReadonlyArray<BoardSummaryElement>) => {
  const elements: Array<BoardSummaryElement> = [];
  let bytes = 0;
  for (const element of candidates) {
    const clipped = clipBoardSummary(element);
    bytes += JSON.stringify(clipped).length;
    if (elements.length > 0 && bytes > PAGE_BYTES) break;
    elements.push(clipped);
  }
  return elements;
};

const make = Effect.gen(function* () {
  const boards = yield* BoardService.BoardService;
  const random = yield* SecureRandom.SecureRandom;

  /** Ids and seeds for up to `count` new elements, drawn in one read. */
  const randomSource = Effect.fn("BoardToolkit.randomSource")(function* (count: number) {
    const bytes = Buffer.from(yield* random.randomBytes(count * (ID_BYTES + SEED_BYTES)));
    let ids = 0;
    let seeds = 0;
    return {
      id: () => {
        if (ids >= count) throw new Error("Board edit used more ids than it reserved.");
        const offset = ids++ * ID_BYTES;
        return bytes.subarray(offset, offset + ID_BYTES).toString("base64url");
      },
      seed: () => {
        if (seeds >= count) throw new Error("Board edit used more seeds than it reserved.");
        return bytes.readUInt32BE(count * ID_BYTES + seeds++ * SEED_BYTES) % MAX_SEED;
      },
    };
  });

  return {
    board_get: McpToolAccess.readsAsCaller((input) =>
      Effect.gen(function* () {
        const thread = yield* callerThread();
        const snapshot = yield* boards.get(thread.threadId).pipe(Effect.mapError(toFailure));
        if (snapshot === null) {
          return { boardId: null, revision: 0, total: 0, elements: [] } satisfies BoardGetResult;
        }
        const revision = snapshot.board.revision;
        const filter = filterKey(input.ids, input.text);
        let offset = 0;
        if (input.cursor !== undefined) {
          const cursor = parseCursor(input.cursor);
          if (cursor === null) return yield* invalid("Pass a nextCursor from board_get.");
          if (cursor.revision !== revision) {
            return yield* invalid(
              `The board changed (now revision ${revision}). Read it again without cursor.`,
            );
          }
          if (cursor.filter !== filter) {
            return yield* invalid(
              "This cursor belongs to a read with other ids or text. Pass the same ids and text, or read again without cursor.",
            );
          }
          offset = cursor.offset;
        }
        const ids = input.ids === undefined ? undefined : new Set(input.ids);
        const needle = input.text?.toLowerCase();
        const matching = summarizeBoard(snapshot).filter(
          (element) =>
            (ids === undefined || ids.has(element.id)) &&
            (needle === undefined ||
              (element.label ?? element.text ?? "").toLowerCase().includes(needle)),
        );
        const elements = page(matching.slice(offset, offset + (input.limit ?? DEFAULT_LIMIT)));
        const end = offset + elements.length;
        return {
          boardId: snapshot.board.boardId,
          revision,
          total: matching.length,
          elements,
          ...(end < matching.length ? { nextCursor: `${revision}:${end}:${filter}` } : {}),
        } satisfies BoardGetResult;
      }),
    ),
    board_create: McpToolAccess.actsAsCaller(() =>
      Effect.gen(function* () {
        const thread = yield* callerThread();
        yield* refusePlanMode();
        const board = yield* boards.create(thread.threadId).pipe(Effect.mapError(toFailure));
        return { boardId: board.boardId, revision: board.revision };
      }),
    ),
    board_apply: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const thread = yield* callerThread();
        yield* refusePlanMode();
        const tokened = input.edits.some((edit) => edit.op !== "create");
        if (tokened && input.revision === undefined) {
          return yield* invalid("Patch and delete need revision: the one your tokens came from.");
        }
        const snapshot = yield* boards.get(thread.threadId).pipe(Effect.mapError(toFailure));
        if (snapshot === null) {
          return yield* invalid("This thread has no board yet. Call board_create first.");
        }
        // A create makes at most an element and its label; a patch at most a label.
        const compiled = compileBoardEdits({
          snapshot,
          edits: input.edits,
          random: yield* randomSource(input.edits.length * 2),
          now: DateTime.toEpochMillis(yield* DateTime.now),
        });
        if (compiled._tag === "Invalid") return yield* invalid(compiled.message);
        if (compiled._tag === "Stale") return yield* boardEditConflict(compiled.conflicts);
        if (compiled.operations.length > BOARD_MAX_OPERATIONS) {
          return yield* invalid("This edit touches too many elements. Split it into smaller ones.");
        }
        // Dependents carry tokens from this snapshot, not the agent's read, so a label the user
        // renamed after that read would be overwritten. Any change since then refuses the batch.
        if (
          tokened &&
          input.revision !== snapshot.board.revision &&
          compiled.dependents.length > 0
        ) {
          return yield* boardEditConflict(compiled.dependents);
        }
        // The mode may have changed while this edit compiled.
        yield* refusePlanMode();
        const result = yield* boards
          .apply({
            // Receipts belong to this provider session in this thread.
            actor: `mcp:${thread.threadId}:${thread.providerSessionId}`,
            batch: {
              threadId: thread.threadId,
              boardId: snapshot.board.boardId,
              mutationId: yield* random.uuidV4(),
              operations: compiled.operations,
            },
          })
          .pipe(Effect.mapError(toFailure));
        return {
          revision: result.revision,
          ids: compiled.ids,
          elements: result.elements
            .filter((element) => !compiled.labelIds.has(element.id))
            .map(({ id, version, versionNonce }) => ({ id, version, versionNonce })),
        };
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof BoardToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(BoardToolkit, make);
