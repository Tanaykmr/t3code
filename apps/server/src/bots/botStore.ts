import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Bots own their tables and create them on first use, like the workflow engine's
 * journal, so this fork never claims a migration id that upstream may reuse.
 */
/** Adds a column unless present; another layer may add it concurrently at start. */
const addColumn = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  table: "bots" | "bot_deliveries",
  column: string,
  definition: string,
) {
  const hasColumn = sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info(${table})`.pipe(
    Effect.map((columns) => columns.some((entry) => entry.name === column)),
  );
  if (yield* hasColumn) return;
  const added = yield* sql
    .unsafe(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    .pipe(Effect.exit);
  if (added._tag === "Failure" && !(yield* hasColumn)) return yield* Effect.failCause(added.cause);
});

export const ensureBotSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS bots (
      bot_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      title TEXT NOT NULL,
      avatar TEXT NOT NULL,
      persona TEXT NOT NULL,
      persona_revision INTEGER NOT NULL,
      project_id TEXT NOT NULL,
      -- The creation intent: a pending bot relaunches its DM with the same command after a restart.
      model_selection_json TEXT NOT NULL,
      dm_thread_id TEXT UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    )
  `;
  yield* addColumn(sql, "bots", "allowed_project_ids_json", "TEXT NOT NULL DEFAULT '[]'");
  // Another bot's messages reach this bot in a seat of its own, never in its private DM.
  yield* addColumn(sql, "bots", "peer_thread_id", "TEXT");
  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_rooms (
      room_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      default_bot_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_room_members (
      room_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (room_id, bot_id)
    )
  `;
  // A member answers in its own thread; the room shows the shared transcript.
  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_room_threads (
      room_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE,
      PRIMARY KEY (room_id, bot_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE,
      channel_key TEXT NOT NULL,
      sender_kind TEXT NOT NULL,
      sender_bot_id TEXT,
      text TEXT NOT NULL,
      mentions_json TEXT NOT NULL,
      reply_to_id TEXT,
      origin_thread_id TEXT,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS bot_messages_channel ON bot_messages (channel_key, seq)`;
  // UNIQUE (message, target) is the replay guard: a resend never wakes a bot twice.
  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_deliveries (
      delivery_id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      target_bot_id TEXT NOT NULL,
      root_message_id TEXT NOT NULL,
      hop INTEGER NOT NULL,
      expects_reply INTEGER NOT NULL,
      status TEXT NOT NULL,
      thread_id TEXT,
      run_id TEXT,
      reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (message_id, target_bot_id)
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS bot_deliveries_status ON bot_deliveries (status, created_at)`;
  // A bot's message carries the sender's mode, so it never wakes a bot that runs with more access.
  yield* addColumn(sql, "bot_deliveries", "sender_runtime_mode", "TEXT");
  yield* sql`CREATE INDEX IF NOT EXISTS bot_deliveries_thread ON bot_deliveries (thread_id, status)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_memories (
      memory_id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      text TEXT NOT NULL,
      source TEXT NOT NULL,
      source_thread_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS bot_memories_bot ON bot_memories (bot_id, updated_at)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_skills (
      skill_id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      name TEXT NOT NULL,
      instructions TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});

export interface BotRoomRow {
  readonly room_id: string;
  readonly name: string;
  readonly default_bot_id: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly archived_at: string | null;
}

/** Rooms with their members and participant threads, in a shape `BotRoom` decodes. */
export const readRooms = Effect.fnUntraced(function* (sql: SqlClient.SqlClient, roomId?: string) {
  const rooms =
    roomId === undefined
      ? yield* sql<BotRoomRow>`SELECT * FROM bot_rooms ORDER BY created_at, room_id`
      : yield* sql<BotRoomRow>`SELECT * FROM bot_rooms WHERE room_id = ${roomId}`;
  const members =
    roomId === undefined
      ? yield* sql<{ room_id: string; bot_id: string }>`
          SELECT room_id, bot_id FROM bot_room_members ORDER BY room_id, position
        `
      : yield* sql<{ room_id: string; bot_id: string }>`
          SELECT room_id, bot_id FROM bot_room_members WHERE room_id = ${roomId} ORDER BY position
        `;
  const threads =
    roomId === undefined
      ? yield* sql<{ room_id: string; bot_id: string; thread_id: string }>`
          SELECT room_id, bot_id, thread_id FROM bot_room_threads
        `
      : yield* sql<{ room_id: string; bot_id: string; thread_id: string }>`
          SELECT room_id, bot_id, thread_id FROM bot_room_threads WHERE room_id = ${roomId}
        `;
  return rooms.map((room) => ({
    id: room.room_id,
    name: room.name,
    memberBotIds: members.filter((m) => m.room_id === room.room_id).map((m) => m.bot_id),
    defaultBotId: room.default_bot_id,
    participants: threads
      .filter((t) => t.room_id === room.room_id)
      .map((t) => ({ botId: t.bot_id, threadId: t.thread_id })),
    createdAt: room.created_at,
    updatedAt: room.updated_at,
    archivedAt: room.archived_at,
  }));
});

export interface BotRow {
  readonly bot_id: string;
  readonly name: string;
  readonly title: string;
  readonly avatar: string;
  readonly persona: string;
  readonly persona_revision: number;
  readonly project_id: string;
  readonly model_selection_json: string;
  readonly dm_thread_id: string | null;
  readonly allowed_project_ids_json: string;
  readonly peer_thread_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly archived_at: string | null;
}

export interface TurnOrigin {
  readonly origin_run_id: string;
  readonly message_id: string | null;
  readonly scheduled_task_id: string | null;
  readonly sender_thread_id: string | null;
}

/**
 * The input that started the thread's executing turn, following restart and continuation
 * runs back to the first: a server-written continuation keeps the provenance of what it
 * continues.
 */
export const executingTurnOrigin = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  threadId: string,
) {
  const [origin] = yield* sql<TurnOrigin>`
    WITH RECURSIVE chain(run_id, payload_json, depth) AS (
      SELECT * FROM (
        SELECT run_id, payload_json, 0 FROM orchestration_v2_projection_runs
        WHERE thread_id = ${threadId} AND status IN ('starting', 'running', 'waiting')
        ORDER BY ordinal DESC LIMIT 1
      )
      UNION ALL
      SELECT run.run_id, run.payload_json, chain.depth + 1
      FROM orchestration_v2_projection_runs AS run
      JOIN chain ON run.run_id = COALESCE(
        json_extract(chain.payload_json, '$.restartContinuationOfRunId'),
        json_extract(chain.payload_json, '$.usageLimitContinuationOfRunId'),
        json_extract(chain.payload_json, '$.manualContinuationOfRunId')
      )
      WHERE chain.depth < 20
    )
    SELECT chain.run_id AS origin_run_id, message.message_id,
      json_extract(message.payload_json, '$.scheduledTaskId') AS scheduled_task_id,
      json_extract(message.payload_json, '$.senderThreadId') AS sender_thread_id
    FROM chain
    LEFT JOIN orchestration_v2_projection_messages AS message
      ON message.message_id = json_extract(chain.payload_json, '$.userMessageId')
    ORDER BY chain.depth DESC LIMIT 1
  `;
  return origin;
});
