import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The Boat environment a scoped key may create in. Each machine keeps the one it was created
  // in, so changing the account's later never moves where its resumes go.
  const accountColumn = yield* sql`
    SELECT name FROM pragma_table_info('boat_account') WHERE name = 'boat_environment'
  `;
  if (accountColumn.length === 0) {
    yield* sql`ALTER TABLE boat_account ADD COLUMN boat_environment TEXT`;
  }
  const serverColumn = yield* sql`
    SELECT name FROM pragma_table_info('boat_servers') WHERE name = 'boat_environment'
  `;
  if (serverColumn.length === 0) {
    yield* sql`ALTER TABLE boat_servers ADD COLUMN boat_environment TEXT`;
  }
});
