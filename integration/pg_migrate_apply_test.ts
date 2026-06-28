/**
 * PostgreSQL migration-applier integration suite for `@sisal/pg` /
 * `@sisal/migrate` (roadmap item 2).
 *
 * Proves the serverless-safe **statement-by-statement apply mode** end to end:
 * a single multi-statement `.sql` migration whose `CREATE FUNCTION ... $$ ... ;
 * ... $$` body contains semicolons is applied with `splitStatements: true`, so
 * `splitSqlStatements` must keep the dollar-quoted body whole — the live
 * PostgreSQL parser is the oracle (a mis-split body is a syntax error). Also
 * checks that history is recorded, re-runs are idempotent, and `down` rolls
 * back.
 *
 * Gated on `DATABASE_URL` (skipped when unset), like `pg_features_test.ts`. Run:
 *
 *   DATABASE_URL=postgres://postgres:postgres@localhost:55418/sisal \
 *     deno test --allow-net --allow-env --allow-read \
 *     integration/pg_migrate_apply_test.ts
 *
 * @module
 */
import { assert, assertEquals } from "@std/assert";
import { raw, sql } from "@sisal/orm";
import { defineSqlMigration } from "@sisal/migrate";
import { connect, createPgMigrator, type PgDatabase } from "@sisal/pg";

function databaseUrl(): string | undefined {
  try {
    return (globalThis as {
      Deno?: { env: { get(k: string): string | undefined } };
    })
      .Deno?.env.get("DATABASE_URL") ?? undefined;
  } catch {
    return undefined;
  }
}

const URL = databaseUrl();
const SKIP = URL === undefined;

function pgTest(name: string, fn: (db: PgDatabase) => Promise<void>) {
  Deno.test({
    name,
    ignore: SKIP,
    sanitizeResources: false,
    sanitizeOps: false,
    fn: async () => {
      const db = await connect({ url: URL! });
      try {
        await fn(db);
      } finally {
        await db.close();
      }
    },
  });
}

// A multi-statement migration: a table, a plpgsql function whose body holds
// internal semicolons (the case that breaks a naive `;` split), and an insert
// that calls the function. Applied one statement per call by splitStatements.
const FUNCTION_MIGRATION = defineSqlMigration({
  id: "0001_apply_fn",
  up: [
    "create table it_apply (id integer primary key, n integer);",
    "create function it_apply_double(x integer) returns integer",
    "  language plpgsql as $$",
    "begin",
    "  return x * 2;",
    "end;",
    "$$;",
    "insert into it_apply (id, n) values (1, it_apply_double(21));",
  ].join("\n"),
  down: [
    "drop function if exists it_apply_double(integer);",
    "drop table if exists it_apply;",
  ].join("\n"),
});

async function dropArtifacts(db: PgDatabase): Promise<void> {
  await db.execute(raw("drop table if exists it_apply cascade"));
  await db.execute(
    raw("drop function if exists it_apply_double(integer) cascade"),
  );
  await db.execute(raw("drop table if exists it_apply_history cascade"));
}

pgTest(
  "pg migrate: splitStatements applies a multi-statement function migration",
  async (db) => {
    await dropArtifacts(db);
    const migrator = await createPgMigrator({
      url: URL!,
      historyTable: "it_apply_history",
      splitStatements: true,
    });
    try {
      const result = await migrator.migrate({
        migrations: [FUNCTION_MIGRATION],
      });
      assertEquals(result.executed.map((m) => m.id), ["0001_apply_fn"]);

      // The dollar-quoted function body survived splitting: the function was
      // created whole and ran, so the seeded row is 21 * 2 = 42.
      const rows = await db.query<{ n: number }>(
        sql`select n from it_apply where id = ${1}`,
      );
      assertEquals(Number(rows.rows[0].n), 42);

      // History is recorded.
      assertEquals(
        (await migrator.applied()).map((m) => m.id),
        ["0001_apply_fn"],
      );

      // Re-running applies nothing (durable history).
      const second = await migrator.migrate({
        migrations: [FUNCTION_MIGRATION],
      });
      assertEquals(second.executed.length, 0);
    } finally {
      await migrator.close();
    }
  },
);

pgTest(
  "pg migrate: rollback also applies its statements and clears history",
  async (db) => {
    const migrator = await createPgMigrator({
      url: URL!,
      historyTable: "it_apply_history",
      splitStatements: true,
    });
    try {
      const rolledBack = await migrator.rollback({
        migrations: [FUNCTION_MIGRATION],
      });
      assertEquals(rolledBack.executed.map((m) => m.id), ["0001_apply_fn"]);
      assertEquals((await migrator.applied()).length, 0);

      // The table and function are gone after the down step ran.
      const exists = await db.query<{ present: boolean }>(
        sql`select to_regclass(${"it_apply"}) is not null as present`,
      );
      assert(!exists.rows[0].present);
    } finally {
      await migrator.close();
      await dropArtifacts(db);
    }
  },
);
