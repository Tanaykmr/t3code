import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A thread's Excalidraw board. File bytes live here, not in the asset store, so an edit and the
// images it adds commit in one transaction. Tombstones and receipts stay for the board's lifetime.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS board (
      board_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL UNIQUE,
      scene_format_version INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      order_revision INTEGER NOT NULL,
      view_background_color TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS board_element (
      board_id TEXT NOT NULL,
      element_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      version_nonce INTEGER NOT NULL,
      idx TEXT,
      is_deleted INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (board_id, element_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS board_file (
      board_id TEXT NOT NULL,
      file_id TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      digest TEXT NOT NULL,
      created INTEGER NOT NULL,
      bytes BLOB NOT NULL,
      PRIMARY KEY (board_id, file_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS board_mutation (
      board_id TEXT NOT NULL,
      mutation_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      result_json TEXT NOT NULL,
      PRIMARY KEY (board_id, mutation_id)
    )
  `;
});
