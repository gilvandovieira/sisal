/**
 * Migration runner for the example.
 *
 * Applies migrations/*.sql in order. The Neon serverless driver allows one
 * statement per call (extended protocol), so each file is split into single
 * statements via `splitSqlStatements` — the shared, dollar-quote-aware splitter
 * from `@sisal/migrate` — and executed one at a time. This example has a single
 * migration with only `CREATE TABLE` / `CREATE INDEX` (no functions), so the
 * split is simple; the shared splitter is reused for consistency with the other
 * Neon examples. All DDL is idempotent (`IF NOT EXISTS`), so re-running is safe.
 *
 *   deno run --env-file=.env --allow-env --allow-net --allow-read src/migrate.ts
 *   deno run --env-file=.env --allow-env --allow-net --allow-read src/migrate.ts --reset
 *
 * `--reset` drops the tables first (destructive — local/dev only).
 *
 * @module
 */

import { raw } from "@sisal/orm";
import { splitSqlStatements } from "@sisal/migrate";
import type { NeonDatabase } from "./db.ts";
import { openAdminDb } from "./db.ts";

/** Migration files, applied in this order. */
export const MIGRATION_FILES = ["0001_init.sql"] as const;

/** Drops everything this example creates. Destructive; dev/local only. */
export async function resetSchema(db: NeonDatabase): Promise<void> {
  await db.execute(raw("drop table if exists post_activity_actors cascade"));
  await db.execute(raw("drop table if exists post_activity_buckets cascade"));
  await db.execute(raw("drop table if exists posts cascade"));
}

/** Applies all migration files to the given database. */
export async function runMigrations(
  db: NeonDatabase,
  options: { readonly reset?: boolean } = {},
): Promise<void> {
  if (options.reset) {
    await resetSchema(db);
    console.log("reset: dropped posts and activity tables");
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
