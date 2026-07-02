/**
 * Migration runner for the MySQL-family rising-feed example.
 *
 * MySQL and MariaDB DDL implicitly commit, so migrations here are idempotent
 * SQL files applied statement-by-statement. `--reset` drops the example tables
 * first and is intended for local/demo databases only.
 *
 * @module
 */

import { raw } from "@sisal/orm";
import { splitSqlStatements } from "@sisal/migrate";
import type { MysqlDatabase } from "@sisal/mysql";
import { openAdminDb } from "./db.ts";

/** Migration files, applied in this order. */
export const MIGRATION_FILES = ["0001_init.sql"] as const;

/** Drops everything this example creates. Destructive; dev/local only. */
export async function resetSchema(db: MysqlDatabase): Promise<void> {
  await db.execute(raw("drop table if exists post_activity_actors"));
  await db.execute(raw("drop table if exists post_activity_buckets"));
  await db.execute(raw("drop table if exists posts"));
}

/** Applies all migration files to the given database. */
export async function runMigrations(
  db: MysqlDatabase,
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

function stripSqlLineComments(statement: string): string {
  return statement
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .trim();
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
