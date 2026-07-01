/**
 * SQLite-**family** rising-feed example for Sisal.
 *
 * The SQLite-family counterpart to `examples/postgres-family-feed`, running over
 * either `@sisal/libsql` (libSQL/Turso, default) or embedded `@sisal/sqlite` —
 * selected with `SISAL_ADAPTER` (see `src/db.ts`); `SqliteDatabase` ≡
 * `LibsqlDatabase`, so the app code is identical across both. It proves the same
 * feature — posts + time-bucketed activity, `/new` and `/rising` timelines
 * backed by a stored, TIME-DEPENDENT moving-window score, keyset pagination —
 * on an engine with NO stored procedures, so the bucket math, the atomic
 * activity recorder, and the score recompute all live in TypeScript and are
 * orchestrated through the query builder (transactions, upserts with raw `sql`
 * increments, and `db.batch`). See README.md.
 *
 *   SISAL_ADAPTER=libsql deno run -A examples/sqlite-family-feed/mod.ts
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
