/**
 * SQLite feature/compatibility suite for `@sisal/sqlite`.
 *
 * SQLite is embedded (via `jsr:@db/sqlite`), so no server is needed — the suite
 * opens a temp database file and exercises every adapter feature end-to-end. It
 * is gated on `SISAL_SQLITE_IT=1` so it stays out of the ordinary `deno task
 * test` (which is FFI-free). Run it with:
 *
 *   SISAL_SQLITE_IT=1 deno test --allow-ffi --allow-read --allow-write \
 *     --allow-env --allow-net integration/sqlite_features_test.ts
 *
 * Each `Deno.test` name maps to a row in docs/sqlite-compatibility.md. Tests
 * that document a SQLite difference assert the real behavior (e.g. JSON/arrays
 * round-trip as text), so the whole suite stays green while the matrix stays
 * honest.
 *
 * @module
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  and,
  asc,
  avg,
  between,
  columns,
  count,
  createSchemaSnapshot,
  defineTable,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  max,
  min,
  ne,
  not,
  notBetween,
  notInArray,
  notLike,
  or,
  raw,
  sql,
  sum,
} from "@sisal/orm";
import { defineSqlMigration } from "@sisal/migrate";
import {
  connect,
  createSqliteMigrator,
  type SqliteDatabase,
} from "@sisal/sqlite";
import { generateSqliteUpStatements } from "@sisal/sqlite/ddl";

const RUN = (() => {
  try {
    return (globalThis as {
      Deno?: { env: { get(k: string): string | undefined } };
    })
      .Deno?.env.get("SISAL_SQLITE_IT") === "1";
  } catch {
    return false;
  }
})();

let dbPath: string | undefined;
let dbHandle: SqliteDatabase | undefined;
async function db(): Promise<SqliteDatabase> {
  if (dbHandle === undefined) {
    dbPath = await Deno.makeTempFile({ suffix: ".sqlite" });
    dbHandle = await connect({ path: dbPath });
  }
  return dbHandle;
}

function sqliteTest(
  name: string,
  fn: (db: SqliteDatabase) => Promise<void> | void,
) {
  Deno.test({
    name,
    ignore: !RUN,
    sanitizeResources: false,
    sanitizeOps: false,
    fn: async () => {
      await fn(await db());
    },
  });
}

// ---- schema (scalar-only seed; arrays/JSON are probed separately) ----------

const orgs = defineTable("it_orgs", {
  id: columns.integer().primaryKey(),
  name: columns.text().notNull(),
});

const users = defineTable("it_users", {
  id: columns.integer().primaryKey(),
  email: columns.text().notNull(),
  name: columns.text(),
  age: columns.integer(),
  active: columns.boolean(),
  score: columns.numeric(10, 2),
  orgId: columns.integer(),
});

const posts = defineTable("it_posts", {
  id: columns.integer().primaryKey(),
  title: columns.text().notNull(),
  updatedAt: columns.integer()
    .$onUpdate(() => 1700000000),
});

const docs = defineTable("it_docs", {
  id: columns.integer().primaryKey(),
  data: columns.jsonb<{ note: string }>(),
  tags: columns.text().array(),
});

// Exhaustive column-type table — exercises generated DDL on SQLite affinities.
const allTypes = defineTable("it_all_types", {
  id: columns.serial().primaryKey(),
  c_text: columns.text(),
  c_varchar: columns.varchar(50),
  c_char: columns.char(4),
  c_int: columns.integer(),
  c_smallint: columns.smallint(),
  c_bigint: columns.bigint(),
  c_numeric: columns.numeric(10, 2),
  c_real: columns.real(),
  c_double: columns.doublePrecision(),
  c_bool: columns.boolean(),
  c_json: columns.json(),
  c_jsonb: columns.jsonb(),
  c_date: columns.date(),
  c_ts: columns.timestamp(),
  c_uuid: columns.uuid(),
  c_blob: columns.bytea(),
});

// ---------------------------------------------------------------------------

sqliteTest("sqlite: connect + raw parameterized query", async (db) => {
  const result = await db.query<{ one: number; who: string }>(
    sql`select 1 as one, ${"sisal"} as who`,
  );
  assertEquals(Number(result.rows[0].one), 1);
  assertEquals(result.rows[0].who, "sisal");
});

sqliteTest("sqlite: generated DDL applies (affinity mapping)", async (db) => {
  await db.execute(raw("drop table if exists it_all_types"));
  await db.execute(raw("drop table if exists it_docs"));
  await db.execute(raw("drop table if exists it_posts"));
  await db.execute(raw("drop table if exists it_users"));
  await db.execute(raw("drop table if exists it_orgs"));

  const snapshot = createSchemaSnapshot({
    dialect: "sqlite",
    tables: [orgs, users, posts, docs, allTypes],
  });
  const { statements, destructive } = generateSqliteUpStatements(snapshot);
  assertEquals(destructive.length, 0);
  for (const statement of statements) {
    await db.execute(statement);
  }

  const cols = await db.query<{ n: number }>(
    sql`select count(*) as n from pragma_table_info(${"it_all_types"})`,
  );
  assertEquals(Number(cols.rows[0].n), 17);
});

sqliteTest("sqlite: insert + returning", async (db) => {
  await db.insert(orgs).values([
    { id: 1, name: "Acme" },
    { id: 2, name: "Globex" },
  ]).execute();

  const inserted = await db.insert(users).values({
    id: 1,
    email: "a@example.com",
    name: "Alice",
    age: 30,
    active: true,
    score: "10.50",
    orgId: 1,
  }).returning().execute();
  assertEquals(inserted.rows[0].id, 1);
  assertEquals(inserted.rows[0].email, "a@example.com");

  await db.insert(users).values([
    {
      id: 2,
      email: "b@example.com",
      name: "Bob",
      age: 17,
      active: false,
      score: "5.00",
      orgId: 1,
    },
    {
      id: 3,
      email: "c@example.com",
      name: "Cara",
      age: 41,
      active: true,
      score: "99.99",
      orgId: 2,
    },
    {
      id: 4,
      email: "d@example.com",
      name: null,
      age: null,
      active: null,
      score: null,
      orgId: null,
    },
  ]).execute();

  assertEquals((await db.select().from(users).execute()).length, 4);
});

sqliteTest(
  "sqlite: filter operators (eq/ne/gt/lt/in/null/and/or/not)",
  async (db) => {
    const len = async (
      cond: Parameters<ReturnType<typeof db.select>["where"]>[0],
    ) => (await db.select().from(users).where(cond).execute()).length;

    assertEquals(await len(eq(users.columns.id, 1)), 1);
    assertEquals(await len(ne(users.columns.id, 1)), 3);
    assertEquals(await len(gt(users.columns.age, 18)), 2);
    assertEquals(await len(gte(users.columns.age, 17)), 3);
    assertEquals(await len(lt(users.columns.age, 30)), 1);
    assertEquals(await len(lte(users.columns.age, 30)), 2);
    assertEquals(await len(between(users.columns.age, 18, 40)), 1);
    assertEquals(await len(notBetween(users.columns.age, 18, 40)), 2);
    assertEquals(await len(inArray(users.columns.id, [1, 2])), 2);
    assertEquals(await len(notInArray(users.columns.id, [1, 2])), 2);
    assertEquals(await len(isNull(users.columns.age)), 1);
    assertEquals(await len(isNotNull(users.columns.age)), 3);
    assertEquals(
      await len(and(eq(users.columns.active, true), gt(users.columns.age, 20))),
      2,
    );
    assertEquals(
      await len(or(eq(users.columns.id, 1), eq(users.columns.id, 2))),
      2,
    );
    assertEquals(await len(not(eq(users.columns.id, 1))), 3);
  },
);

sqliteTest("sqlite: like / notLike", async (db) => {
  assertEquals(
    (await db.select().from(users).where(like(users.columns.email, "a%"))
      .execute())
      .length,
    1,
  );
  assertEquals(
    (await db.select().from(users).where(notLike(users.columns.email, "a%"))
      .execute())
      .length,
    3,
  );
});

sqliteTest(
  "sqlite: ilike works (degrades to case-insensitive LIKE)",
  async (db) => {
    // SQLite has no ILIKE; Sisal renders it as the (ASCII case-insensitive) LIKE.
    const rows = await db.select().from(users)
      .where(ilike(users.columns.email, "A%")).execute();
    assertEquals(rows.length, 1); // matches lowercase "a@example.com"
  },
);

sqliteTest("sqlite: bytea/BLOB binary round-trip", async (db) => {
  const bin = defineTable("it_bin", {
    id: columns.integer().primaryKey(),
    data: columns.bytea(),
  });
  await db.execute(
    generateSqliteUpStatements(
      createSchemaSnapshot({ dialect: "sqlite", tables: [bin] }),
    ).statements[0],
  );
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  await db.insert(bin).values({ id: 1, data: bytes }).execute();
  const rows = await db.select({ data: bin.columns.data }).from(bin)
    .where(eq(bin.columns.id, 1)).execute();
  assertEquals(Array.from(rows[0].data as Uint8Array), [0, 1, 2, 250, 255]);
});

sqliteTest("sqlite: orderBy asc/desc + limit + offset", async (db) => {
  const rows = await db.select().from(users)
    .where(isNotNull(users.columns.age))
    .orderBy(desc(users.columns.age), asc(users.columns.email))
    .limit(2).offset(0).execute();
  assertEquals(rows.map((r) => r.id), [3, 1]);
});

sqliteTest("sqlite: distinct", async (db) => {
  const rows = await db.select({ orgId: users.columns.orgId }).from(users)
    .distinct().execute();
  assertEquals(rows.length, 3); // {1, 2, null}
});

sqliteTest("sqlite: inner / left joins", async (db) => {
  const inner = await db.select({
    u: users.columns.email,
    o: orgs.columns.name,
  })
    .from(users).innerJoin(orgs, eq(orgs.columns.id, users.columns.orgId))
    .execute();
  assertEquals(inner.length, 3);

  const left = await db.select({ uid: users.columns.id, oid: orgs.columns.id })
    .from(users).leftJoin(orgs, eq(orgs.columns.id, users.columns.orgId))
    .execute();
  assertEquals(left.length, 4);
});

sqliteTest("sqlite: right / full joins", async (db) => {
  const projection = { uid: users.columns.id, oid: orgs.columns.id };
  const right = await db.select(projection).from(users)
    .rightJoin(orgs, eq(orgs.columns.id, users.columns.orgId)).execute();
  assert(right.length >= 3);
  const full = await db.select(projection).from(users)
    .fullJoin(orgs, eq(orgs.columns.id, users.columns.orgId)).execute();
  assert(full.length >= 4);
});

sqliteTest("sqlite: aggregates + groupBy + having", async (db) => {
  const grouped = await db.select({
    orgId: users.columns.orgId,
    n: count(),
    avgAge: avg(users.columns.age),
    total: sum(users.columns.age),
    youngest: min(users.columns.age),
    oldest: max(users.columns.age),
  }).from(users)
    .where(isNotNull(users.columns.orgId))
    .groupBy(users.columns.orgId)
    .having(gt(count(), 1))
    .execute();
  assertEquals(grouped.length, 1);
  assertEquals(Number(grouped[0].n), 2);
});

sqliteTest("sqlite: update + returning + $onUpdate", async (db) => {
  await db.insert(posts).values({ id: 1, title: "first", updatedAt: null })
    .execute();
  const updated = await db.update(posts).set({ title: "renamed" })
    .where(eq(posts.columns.id, 1)).returning().execute();
  assertEquals(updated.rows[0].title, "renamed");
  assertEquals(Number(updated.rows[0].updatedAt), 1700000000);
});

sqliteTest("sqlite: delete + returning", async (db) => {
  await db.insert(users).values({
    id: 99,
    email: "tmp@example.com",
    name: "Temp",
    age: 50,
    active: true,
    score: "1.00",
    orgId: 1,
  }).execute();
  const removed = await db.delete(users).where(eq(users.columns.id, 99))
    .returning().execute();
  assertEquals(removed.rows[0].id, 99);
});

sqliteTest(
  "sqlite: upsert (onConflictDoNothing / onConflictDoUpdate)",
  async (db) => {
    await db.insert(orgs).values({ id: 1, name: "dup" })
      .onConflictDoNothing({ target: orgs.columns.id }).execute();
    assertEquals(
      (await db.select().from(orgs).where(eq(orgs.columns.id, 1)).execute())[0]
        .name,
      "Acme",
    );
    await db.insert(orgs).values({ id: 1, name: "ignored" })
      .onConflictDoUpdate({ target: orgs.columns.id, set: { name: "Acme v2" } })
      .execute();
    assertEquals(
      (await db.select().from(orgs).where(eq(orgs.columns.id, 1)).execute())[0]
        .name,
      "Acme v2",
    );
  },
);

sqliteTest("sqlite: transaction commit and rollback", async (db) => {
  await db.transaction(async (tx) => {
    await tx.insert(orgs).values({ id: 10, name: "Tx" }).execute();
  });
  assertEquals(
    (await db.select().from(orgs).where(eq(orgs.columns.id, 10)).execute())
      .length,
    1,
  );
  await assertRejects(() =>
    db.transaction(async (tx) => {
      await tx.insert(orgs).values({ id: 11, name: "RollMe" }).execute();
      throw new Error("boom");
    })
  );
  assertEquals(
    (await db.select().from(orgs).where(eq(orgs.columns.id, 11)).execute())
      .length,
    0,
  );
});

sqliteTest("sqlite: boolean stored as INTEGER 0/1", async (db) => {
  const rows = await db.select({ active: users.columns.active }).from(users)
    .where(eq(users.columns.id, 1)).execute();
  assertEquals(Number(rows[0].active), 1);
});

sqliteTest(
  "sqlite: JSON object round-trips as text (auto-stringified)",
  async (db) => {
    // SQLite has no JSON type: objects are auto-stringified to TEXT on insert and
    // come back as a JSON string (Postgres `jsonb` returns a parsed object).
    await db.insert(docs).values({ id: 1, data: { note: "x" }, tags: null })
      .execute();
    const rows = await db.query<{ data: string }>(
      sql`select data from it_docs where id = ${1}`,
    );
    assertEquals(rows.rows[0].data, '{"note":"x"}');
    assertEquals(JSON.parse(rows.rows[0].data).note, "x");
  },
);

sqliteTest("sqlite: text[] array round-trips as JSON text", async (db) => {
  // SQLite has no array type: arrays are auto-stringified to a JSON TEXT value.
  await db.insert(docs).values({ id: 2, data: null, tags: ["a", "b"] })
    .execute();
  const rows = await db.query<{ tags: string }>(
    sql`select tags from it_docs where id = ${2}`,
  );
  assertEquals(JSON.parse(rows.rows[0].tags), ["a", "b"]);
});

sqliteTest("sqlite: migrator applies, plans, and is idempotent", async () => {
  const migrator = await createSqliteMigrator({
    path: dbPath!,
    historyTable: "it_history",
  });
  try {
    const migration = defineSqlMigration({
      id: "0001_it_widget",
      up: "create table if not exists it_widget (id integer primary key)",
      down: "drop table if exists it_widget",
    });
    const first = await migrator.migrate({ migrations: [migration] });
    assertEquals(first.executed.map((m) => m.id), ["0001_it_widget"]);
    const plan = await migrator.plan({ migrations: [migration] });
    assertEquals(plan.applied.length, 1);
    assertEquals(plan.pending.length, 0);
    const second = await migrator.migrate({ migrations: [migration] });
    assertEquals(second.executed.length, 0);
  } finally {
    await migrator.close();
  }
});

sqliteTest("sqlite: teardown", async (db) => {
  await db.close();
  dbHandle = undefined;
  if (dbPath !== undefined) {
    try {
      await Deno.remove(dbPath);
    } catch { /* ignore */ }
  }
});
