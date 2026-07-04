/**
 * PostgreSQL-**family** rising-feed example for Sisal.
 *
 * One `/rising` feed app that runs over any PostgreSQL-family driver — `@sisal/pg`
 * on `@db/postgres` or `npm:postgres`, or `@sisal/neon` over a WebSocket —
 * selected with `SISAL_ADAPTER` (see `src/db.ts`). Because the dialect + builder
 * are shared and `NeonDatabase` ≡ `PgDatabase`, the app code is identical across
 * drivers; only the connection differs. Consolidates the former
 * `postgres-rising-feed`, `neon-rising-feed`, and `neon-rising-feed-ctes`.
 *
 * Two recompute strategies are included: `src/recompute.ts` (via PostgreSQL
 * functions, `db.call(...)`) and `src/recompute_ctes.ts` (builder-native chained
 * CTEs, `db.with(...).update(...)`). See README.md.
 *
 *   docker compose up -d
 *   SISAL_ADAPTER=pg deno run --env-file=.env --allow-env --allow-net --allow-read \
 *     examples/postgres-family-feed/mod.ts
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
import { readEnv } from "./src/db.ts";

if (import.meta.main) {
  if (readEnv("DATABASE_URL") === undefined) {
    console.log(
      "This example runs a live PostgreSQL /rising-feed demo. To try it:\n" +
        "  1. docker compose up -d     # local Postgres 18\n" +
        "  2. cp .env.example .env     # sets DATABASE_URL\n" +
        "  3. deno task demo           # migrate + seed + run the feed\n\n" +
        "Required env: DATABASE_URL (see .env.example). " +
        "SISAL_ADAPTER picks pg | pg-db-postgres | neon.",
    );
  } else {
    await main();
  }
}
