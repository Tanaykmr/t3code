import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per Boat machine this controller created. A purged machine keeps its row as a
  // tombstone (`deleted_at`) with its cleanup evidence; the list leaves it out.
  yield* sql`
    CREATE TABLE IF NOT EXISTS boat_servers (
      managed_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      size TEXT NOT NULL,
      ttl_seconds INTEGER NOT NULL,
      lifecycle TEXT NOT NULL,
      sandbox_id TEXT,
      guest_environment_id TEXT,
      origin TEXT,
      observed_power TEXT,
      observed_at TEXT,
      auto_stop_at TEXT,
      retention TEXT NOT NULL,
      usage_json TEXT,
      created_at TEXT NOT NULL,
      last_started_at TEXT,
      last_stopped_at TEXT,
      deleted_at TEXT
    )
  `;
  // The request ID is the client's idempotency key and, for create, Boat's Idempotency-Key.
  yield* sql`
    CREATE TABLE IF NOT EXISTS boat_operations (
      request_id TEXT PRIMARY KEY,
      managed_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      stage TEXT NOT NULL,
      provider_operation_id TEXT,
      failure TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS boat_operations_by_server
    ON boat_operations (managed_id, created_at)
  `;
  // The account the stored key belongs to; the key itself lives in the secret store.
  yield* sql`
    CREATE TABLE IF NOT EXISTS boat_account (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      account_id TEXT NOT NULL,
      label TEXT NOT NULL,
      status TEXT NOT NULL,
      zero_data_retention INTEGER NOT NULL
    )
  `;
});
