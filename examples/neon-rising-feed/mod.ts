/**
 * Neon rising-feed example for Sisal.
 *
 * A focused database/feed example: posts + time-bucketed activity, a `/new`
 * timeline and a `/rising` timeline backed by a stored, indexable, TIME-
 * DEPENDENT rising score computed from a moving window of recent activity.
 * Activity recording is one atomic `app.record_post_activity` call (a single
 * statement, not an interactive transaction callback), which suits Neon
 * serverless / Deno Deploy.
 *
 * This module re-exports the example's building blocks and runs the demo when
 * executed directly. See README.md for setup, the Neon constraint, the
 * moving-average explanation, and the Sisal API pressure points this example
 * surfaces.
 *
 *   deno run --env-file=.env --allow-env --allow-net --allow-read \
 *     examples/neon-rising-feed/mod.ts
 *
 * @module
 */

export * from "./src/db.ts";
export * from "./src/schema.ts";
export * from "./src/rising.ts";
// The dollar-quote-aware SQL splitter ships in @sisal/migrate (the example
// reuses it instead of carrying a local sql_split.ts copy).
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
