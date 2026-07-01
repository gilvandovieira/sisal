/**
 * Migration runner for the libSQL example.
 *
 * There is only one migration: SQLite cannot define the stored functions the
 * Neon sibling uses, so the schema is just tables + indexes. Each `.sql` file is
 * split into single statements via `splitSqlStatements` (shared from
 * `@sisal/migrate`) and executed one at a time. DDL is idempotent
 * (`IF NOT EXISTS`), so re-running is safe.
 *
 *   deno run -A src/migrate.ts
 *   deno run -A src/migrate.ts --reset
 *
 * `--reset` drops the tables first (destructive — local/dev only).
 *
 * @module
 */

import { raw } from "@sisal/orm";
import { splitSqlStatements } from "@sisal/migrate";
import type { LibsqlDatabase } from "@sisal/libsql";
import { openDb } from "./db.ts";

/** Migration files, applied in this order. */
export const MIGRATION_FILES = ["0001_init.sql"] as const;

/** Drops everything this example creates. Destructive; dev/local only. */
export async function resetSchema(db: LibsqlDatabase): Promise<void> {
  await db.execute(raw("drop table if exists post_activity_actors"));
  await db.execute(raw("drop table if exists post_activity_buckets"));
  await db.execute(raw("drop table if exists posts"));
}

/** Applies all migration files to the given database. */
export async function runMigrations(
  db: LibsqlDatabase,
  options: { readonly reset?: boolean } = {},
): Promise<void> {
  if (options.reset) {
    await resetSchema(db);
    console.log("reset: dropped posts and activity tables");
  }

  for (const file of MIGRATION_FILES) {
    const path = new URL(`../migrations/${file}`, import.meta.url);
    const text = await Deno.readTextFile(path);
    const statements = splitSqlStatements(text)
      .map(stripSqlLineComments)
      .filter((statement) => statement.length > 0);
    for (const statement of statements) {
      await db.execute(raw(statement));
    }
    console.log(`applied ${file} (${statements.length} statement(s))`);
  }
}

/**
 * Strips `--` line comments (and surrounding blank lines) from a migration
 * statement. The libSQL client tolerates leading/inline comments, but embedded
 * `@db/sqlite` (the `sqlite` adapter) rejects some commented DDL as "incomplete
 * input", so the shared runner normalizes comments away. Safe here because these
 * DDL migrations contain no string literals holding `--`.
 */
function stripSqlLineComments(statement: string): string {
  return statement
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .trim();
}

async function main(): Promise<void> {
  const reset = Deno.args.includes("--reset");
  const db = await openDb();
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
