/**
 * libSQL/Turso rising-feed example for Sisal.
 *
 * The SQLite counterpart to `examples/neon-rising-feed`. It proves the same
 * thing — posts + time-bucketed activity, a `/new` and a `/rising` timeline
 * backed by a stored, TIME-DEPENDENT moving-window score, keyset pagination —
 * but on an engine with NO stored procedures. So the bucket math, the atomic
 * activity recorder, and the score recompute all live in TypeScript and are
 * orchestrated through the Sisal query builder (transactions, upserts with raw
 * `sql` increments, and `db.batch`). See README.md for the full comparison and
 * the Sisal API pressure points this pairing surfaces.
 *
 *   deno run -A examples/libsql-rising-feed/mod.ts
 *
 * @module
 */

export * from "./src/db.ts";
export * from "./src/schema.ts";
export * from "./src/rising.ts";
export { splitSqlStatements } from "@sisal/migrate";
export * from "./src/queries.ts";
export * from "./src/activity.ts";
export * from "./src/recompute.ts";
export * from "./src/seed.ts";
export { MIGRATION_FILES, resetSchema, runMigrations } from "./src/migrate.ts";
export { main } from "./src/main.ts";

import { main } from "./src/main.ts";

if (import.meta.main) {
  await main();
}
