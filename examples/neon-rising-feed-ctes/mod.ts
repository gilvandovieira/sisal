/**
 * Neon rising-feed (CTE) example for Sisal.
 *
 * The same `/rising` product feature as `examples/neon-rising-feed`, but with NO
 * database functions: every multi-step mutation (record activity, recompute
 * scores) is expressed as ONE data-modifying CTE statement from TypeScript. This
 * keeps each operation Neon HTTP-friendly (one parameterized statement, no
 * interactive transaction callback) while revealing how far Sisal's raw-`sql`
 * escape hatch goes before a function helper would be cleaner. See README.md for
 * the CTE-vs-function tradeoff and the Sisal API pressure points it surfaces.
 *
 *   deno run --env-file=.env --allow-env --allow-net --allow-read \
 *     examples/neon-rising-feed-ctes/mod.ts
 *
 * @module
 */

export * from "./src/db.ts";
export * from "./src/schema.ts";
export * from "./src/rising.ts";
export { splitSqlStatements } from "@sisal/migrate";
export * from "./src/queries.ts";
export * from "./src/activity.ts";
export * from "./src/seed.ts";
export { MIGRATION_FILES, resetSchema, runMigrations } from "./src/migrate.ts";
export { main } from "./src/main.ts";

import { main } from "./src/main.ts";

if (import.meta.main) {
  await main();
}
