/**
 * Neon hot-feed example for Sisal.
 *
 * A focused database/feed example: posts + votes, a `/new` timeline and a `/hot`
 * timeline backed by a stored, indexable hot score, and an atomic vote mutation
 * that works well with Neon serverless / Deno Deploy (a single-statement call to
 * the `app.vote_post` SQL function, not an interactive transaction callback).
 *
 * This module re-exports the example's building blocks and runs the demo when
 * executed directly. See README.md for setup, the Neon constraint, and the list
 * of Sisal API pressure points this example surfaces.
 *
 *   deno run --env-file=.env --allow-env --allow-net --allow-read \
 *     examples/neon-hot-feed/mod.ts
 *
 * @module
 */

export * from "./src/db.ts";
export * from "./src/schema.ts";
export * from "./src/hot.ts";
// The dollar-quote-aware SQL splitter now ships in @sisal/migrate.
export { splitSqlStatements } from "@sisal/migrate";
export * from "./src/queries.ts";
export * from "./src/vote.ts";
export * from "./src/seed.ts";
export { MIGRATION_FILES, resetSchema, runMigrations } from "./src/migrate.ts";
export { main } from "./src/main.ts";

import { main } from "./src/main.ts";

if (import.meta.main) {
  await main();
}
