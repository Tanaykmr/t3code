import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const column = yield* sql`
    SELECT name FROM pragma_table_info('boat_servers') WHERE name = 'cleanup_denied'
  `;
  if (column.length === 0) {
    yield* sql`ALTER TABLE boat_servers ADD COLUMN cleanup_denied INTEGER NOT NULL DEFAULT 0`;
  }
});
