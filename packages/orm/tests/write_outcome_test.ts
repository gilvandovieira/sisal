/**
 * Network-free tests for the portable write-outcome (`tryInsert`, v0.9 T15): it
 * reports inserted-vs-conflicted by reading `RETURNING` rows on the pg/sqlite
 * families and the affected-row count on the MySQL family, and fails closed on
 * the `generic` dialect. A recording driver programs each signal.
 */
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  columns,
  createDatabase,
  defineTable,
  type OrmDriver,
  OrmError,
  type OrmQueryResult,
  type SqlQuery,
  tryInsert,
} from "../mod.ts";

const jobs = defineTable("jobs", { id: columns.integer().primaryKey() });

function recordingDriver(
  result: { rows?: Record<string, unknown>[]; rowCount?: number },
): { driver: OrmDriver; statements: SqlQuery[] } {
  const statements: SqlQuery[] = [];
  const run = (query: SqlQuery): Promise<OrmQueryResult> => {
    statements.push(query);
    return Promise.resolve({
      rows: result.rows ?? [],
      rowCount: result.rowCount ?? 0,
    });
  };
  return {
    driver: {
      query: <T = unknown>(q: SqlQuery) => run(q) as Promise<OrmQueryResult<T>>,
      execute: (q: SqlQuery) => run(q),
    },
    statements,
  };
}

const guardedInsert = (db: ReturnType<typeof createDatabase>) =>
  db.insert(jobs).values({ id: 1 }).onConflictDoNothing();

Deno.test("tryInsert: pg uses RETURNING — a returned row means inserted", async () => {
  const { driver, statements } = recordingDriver({ rows: [{ id: 1 }] });
  const db = createDatabase({ driver, dialect: "postgres" });

  const outcome = await tryInsert(db, guardedInsert(db));
  assertEquals(outcome.inserted, true);
  assertEquals(outcome.rowCount, 1);
  assertStringIncludes(
    statements[0].text.toLowerCase(),
    "on conflict do nothing",
  );
  assertStringIncludes(statements[0].text.toLowerCase(), "returning");
});

Deno.test("tryInsert: pg reports a conflict when RETURNING yields no row", async () => {
  const { driver } = recordingDriver({ rows: [] });
  const db = createDatabase({ driver, dialect: "postgres" });

  const outcome = await tryInsert(db, guardedInsert(db));
  assertEquals(outcome.inserted, false);
  assertEquals(outcome.rowCount, 0);
});

Deno.test("tryInsert: SQLite uses RETURNING too", async () => {
  const { driver, statements } = recordingDriver({ rows: [{ id: 1 }] });
  const db = createDatabase({ driver, dialect: "sqlite" });

  assertEquals((await tryInsert(db, guardedInsert(db))).inserted, true);
  assertStringIncludes(statements[0].text.toLowerCase(), "returning");
});

Deno.test("tryInsert: MySQL reads the affected-row count (no RETURNING)", async () => {
  const won = recordingDriver({ rowCount: 1 });
  const wonDb = createDatabase({ driver: won.driver, dialect: "mysql" });
  assertEquals((await tryInsert(wonDb, guardedInsert(wonDb))).inserted, true);
  // The MySQL family must NOT append RETURNING (unsupported on a no-op upsert).
  assertEquals(
    won.statements[0].text.toLowerCase().includes("returning"),
    false,
  );

  const lost = recordingDriver({ rowCount: 0 });
  const lostDb = createDatabase({ driver: lost.driver, dialect: "mysql" });
  assertEquals(
    (await tryInsert(lostDb, guardedInsert(lostDb))).inserted,
    false,
  );
});

Deno.test("tryInsert: fails closed on the generic dialect", async () => {
  const { driver } = recordingDriver({});
  const db = createDatabase({ driver, dialect: "generic" });
  await assertRejects(
    () => tryInsert(db, guardedInsert(db)),
    OrmError,
    "generic",
  );
});
