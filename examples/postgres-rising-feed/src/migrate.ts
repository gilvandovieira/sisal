/**
 * Migration runner for the example.
 *
 * Applies migrations/*.sql in order. Each file is split into single statements
 * via `splitSqlStatements` — the shared, dollar-quote-aware splitter exported
 * from `@sisal/migrate` — and executed one at a time. (Normal PostgreSQL over a
 * TCP session can also run multi-statement strings, but splitting keeps the
 * runner identical to the Neon sibling and isolates failures per statement.)
 * All DDL is idempotent (`IF NOT EXISTS` / `CREATE OR REPLACE`), so re-running
 * is safe.
 *
 *   docker compose up -d
 *   deno run --env-file=.env --allow-env --allow-net --allow-read src/migrate.ts
 *   deno run --env-file=.env --allow-env --allow-net --allow-read src/migrate.ts --reset
 *
 * `--reset` drops the schema first (destructive — local/dev only).
 *
 * @module
 */

import { raw } from "@sisal/orm";
import { splitSqlStatements } from "@sisal/migrate";
import type { PgDatabase } from "@sisal/pg";
import { openAdminDb } from "./db.ts";

/** Migration files, applied in this order. */
export const MIGRATION_FILES = [
  "0001_init.sql",
  "0002_bucket_functions.sql",
  "0003_activity_functions.sql",
  "0004_rising_score_functions.sql",
] as const;

/** Drops everything this example creates. Destructive; dev/local only. */
export async function resetSchema(db: PgDatabase): Promise<void> {
  await db.execute(raw("drop table if exists post_activity_actors cascade"));
  await db.execute(raw("drop table if exists post_activity_buckets cascade"));
  await db.execute(raw("drop table if exists posts cascade"));
  await db.execute(raw("drop schema if exists app cascade"));
}

/** Applies all migration files to the given database. */
export async function runMigrations(
  db: PgDatabase,
  options: { readonly reset?: boolean } = {},
): Promise<void> {
  if (options.reset) {
    await resetSchema(db);
    console.log("reset: dropped posts, activity tables, and schema app");
  }

  for (const file of MIGRATION_FILES) {
    const path = new URL(`../migrations/${file}`, import.meta.url);
    const text = await Deno.readTextFile(path);
    const statements = splitSqlStatements(text);
    for (const statement of statements) {
      await db.execute(raw(statement));
    }
    console.log(`applied ${file} (${statements.length} statement(s))`);
  }
}

async function main(): Promise<void> {
  const reset = Deno.args.includes("--reset");
  const db = await openAdminDb();
  try {
    await runMigrations(db, { reset });
    console.log("migrations complete.");
  } finally {
    await db.close();
  }
}

if (import.meta.main) {
  await main();
}
