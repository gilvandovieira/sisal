/**
 * MySQL-**family** rising-feed example for Sisal.
 *
 * The MySQL-family counterpart to `examples/postgres-family-feed` and
 * `examples/sqlite-family-feed`, running over `@sisal/mysql` on either
 * `npm:mysql2` or the MariaDB connector via `SISAL_ADAPTER`.
 *
 * It proves the same product feature — posts + time-bucketed activity, `/new`
 * and `/rising` timelines backed by a stored moving-window score and keyset
 * pagination — while making MySQL/MariaDB pressure points explicit: no MySQL
 * proper `RETURNING`, `DATETIME(6)` string literals, `ON DUPLICATE KEY UPDATE`,
 * affected-row-based actor dedupe, and a builder-native CTE recompute that must
 * fetch after writing.
 *
 *   docker compose up -d
 *   deno run --env-file=.env --allow-env --allow-net --allow-read \
 *     examples/mysql-family-feed/mod.ts
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
export * from "./src/recompute_ctes.ts";
export * from "./src/seed.ts";
export { MIGRATION_FILES, resetSchema, runMigrations } from "./src/migrate.ts";
export { main } from "./src/main.ts";

import { main } from "./src/main.ts";

if (import.meta.main) {
  await main();
}
