import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Bots own their tables and create them on first use, like the workflow engine's
 * journal, so this fork never claims a migration id that upstream may reuse.
 */
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
  readonly created_at: string;
  readonly updated_at: string;
  readonly archived_at: string | null;
}
