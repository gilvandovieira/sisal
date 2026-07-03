/**
 * PostgreSQL-**family** activity-vectors example for Sisal.
 *
 * Proves Sisal can drive an advanced **SQL analytics** pipeline on the
 * PostgreSQL family — raw events → hourly buckets → window-function moving
 * averages → consolidated stats → an ordered `double precision[]` **activity
 * vector** → similarity, plus daily/monthly **rollups** and event **pruning**.
 * This is deterministic SQL feature vectorization (set-based batch computation),
 * NOT pgvector / AI embeddings. Runs over any PostgreSQL-family driver via
 * `SISAL_ADAPTER` (`pg` default | `pg-db-postgres` | `neon`); see `src/db.ts`.
 *
 * Run the demo:
 *
 *   SISAL_ADAPTER=pg deno run --env-file=.env --allow-env --allow-net \
 *     --allow-read examples/postgres-family-activity-vectors/mod.ts
 *
 * See README.md for the full chain, the feature-vectors-vs-embeddings
 * distinction, the vector dimensions, and the Sisal API pressure points it
 * surfaces (it is built to push advanced per-engine SQL to its limit).
 *
 * @module
 */

export * from "./src/db.ts";
export * from "./src/schema.ts";
export * from "./src/vector.ts";
export * from "./src/events.ts";
export * from "./src/stats.ts";
export * from "./src/retention.ts";
export * from "./src/queries.ts";
export * from "./src/seed.ts";
export { resetSchema, runMigrations } from "./src/migrate.ts";
// The dollar-quote-aware SQL splitter ships in @sisal/migrate.
export { splitSqlStatements } from "@sisal/migrate";
export { main } from "./src/main.ts";

import { main } from "./src/main.ts";

if (import.meta.main) {
  await main();
}
