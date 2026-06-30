/**
 * Migration runner for the example.
 *
 * The whole database — tables, DESC indexes, the CHECK, and both PostgreSQL
 * functions — is **generated from `src/schema.ts`** (there are no hand-written
 * `.sql` migration files). `generatePostgresUpStatements` emits one statement
 * each, which suits the Neon serverless driver (one statement per call), and the
 * generated DDL is idempotent (`CREATE TABLE IF NOT EXISTS` / `CREATE OR REPLACE
 * FUNCTION` / `create schema if not exists`), so re-running is safe.
 *
 * A history-tracking alternative is `createNeonMigrator` from `@sisal/neon` (or
 * the `sisal` CLI with a `provider: "neon"` config) over generated `.sql` files.
 *
 *   deno run --env-file=.env --allow-env --allow-net src/migrate.ts
 *   deno run --env-file=.env --allow-env --allow-net src/migrate.ts --reset
 *
 * `--reset` drops the schema first (destructive — local/dev only).
 *
 * @module
 */

import { createSchemaSnapshot, raw } from "@sisal/orm";
import { generatePostgresUpStatements } from "@sisal/neon/ddl";
import type { NeonDatabase } from "@sisal/neon";
import { openAdminDb } from "./db.ts";
import { posts, postVotes, schemaObjects } from "./schema.ts";

/** The full init DDL generated from `src/schema.ts` (tables + functions). */
export function initStatements(): readonly string[] {
  const snapshot = createSchemaSnapshot({
    dialect: "postgres",
    tables: [posts, postVotes],
    schemaObjects,
  });
  const { statements, destructive } = generatePostgresUpStatements(snapshot);
  if (destructive.length > 0) {
    throw new Error("schema generated destructive DDL; refusing to apply");
  }
  return statements;
}

/** Drops everything this example creates. Destructive; dev/local only. */
export async function resetSchema(db: NeonDatabase): Promise<void> {
  await db.execute(raw("drop table if exists post_votes cascade"));
  await db.execute(raw("drop table if exists posts cascade"));
  await db.execute(raw("drop schema if exists app cascade"));
}

/** Generates the init DDL from the schema and applies it. */
export async function runMigrations(
  db: NeonDatabase,
  options: { readonly reset?: boolean } = {},
): Promise<void> {
  if (options.reset) {
    await resetSchema(db);
    console.log("reset: dropped posts, post_votes, and schema app");
  }

  const statements = initStatements();
  for (const statement of statements) {
    await db.execute(raw(statement));
  }
  console.log(`applied generated init (${statements.length} statement(s))`);
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
