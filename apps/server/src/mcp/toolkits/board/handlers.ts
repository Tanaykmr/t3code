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
import { compileBoardEdits, summarizeBoard } from "../../../board/BoardEdits.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller } from "../../threadAccess.ts";
import { BoardEditConflictError, BoardToolkit, type BoardGetResult } from "./tools.ts";

const DEFAULT_LIMIT = 200;
const ID_BYTES = 15;
const SEED_BYTES = 4;
const MAX_SEED = 2 ** 31;

const toFailure = (error: BoardReadError | BoardApplyError) => {
  switch (error._tag) {
    case "BoardConflictError":
      return new BoardEditConflictError({ conflicts: error.conflicts });
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

const parseCursor = (cursor: string) => {
  const match = /^(\d+):(\d+)$/.exec(cursor);
  return match === null ? null : { revision: Number(match[1]), offset: Number(match[2]) };
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
        let offset = 0;
        if (input.cursor !== undefined) {
          const cursor = parseCursor(input.cursor);
          if (cursor === null) return yield* invalid("Pass a nextCursor from board_get.");
          if (cursor.revision !== revision) {
            return yield* invalid(
              `The board changed (now revision ${revision}). Read it again without cursor.`,
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
        const limit = input.limit ?? DEFAULT_LIMIT;
        const end = offset + limit;
        return {
          boardId: snapshot.board.boardId,
          revision,
          total: matching.length,
          elements: matching.slice(offset, end),
          ...(end < matching.length ? { nextCursor: `${revision}:${end}` } : {}),
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
        if (compiled._tag === "Stale") {
          return yield* new BoardEditConflictError({ conflicts: compiled.conflicts });
        }
        if (compiled.operations.length > BOARD_MAX_OPERATIONS) {
          return yield* invalid("This edit touches too many elements. Split it into smaller ones.");
        }
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
