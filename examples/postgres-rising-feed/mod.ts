/**
 * PostgreSQL 18 rising-feed example for Sisal — the "normal database" version.
 *
 * The same product feature as `examples/neon-rising-feed` and
 * `examples/libsql-rising-feed`, on a regular PostgreSQL 18 TCP/session
 * connection via `@sisal/pg`. There is no Neon serverless / single-statement
 * constraint here, so both database-function calls and interactive transactions
 * are fine — the activity recorder still prefers a PostgreSQL function because
 * it keeps the multi-step mutation atomic and database-local. See README.md for
 * the three-way comparison (normal vs constrained vs feature-limited database).
 *
 *   docker compose up -d
 *   deno run --env-file=.env --allow-env --allow-net --allow-read \
 *     examples/postgres-rising-feed/mod.ts
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
