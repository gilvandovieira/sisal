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
  countDistinct,
  createSchemaSnapshot,
  defineTable,
  desc,
  eq,
  exists,
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
  notExists,
  notInArray,
  notLike,
  or,
  placeholder,
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

sqliteTest("sqlite: $count + countDistinct", async (db) => {
  assertEquals(await db.$count(users), 4);
  assertEquals(await db.$count(users, isNotNull(users.columns.age)), 3);

  const distinct = await db
    .select({ orgs: countDistinct(users.columns.orgId) })
    .from(users).execute();
  assertEquals(Number(distinct[0].orgs), 2); // org ids {1, 2}; null excluded
});

sqliteTest("sqlite: exists / notExists (correlated subquery)", async (db) => {
  const withUsers = db.select({ one: users.columns.id }).from(users)
    .where(eq(users.columns.orgId, orgs.columns.id));
  // Both orgs have at least one member.
  assertEquals(
    (await db.select().from(orgs).where(exists(withUsers)).execute()).length,
    2,
  );
  assertEquals(
    (await db.select().from(orgs).where(notExists(withUsers)).execute()).length,
    0,
  );
});

sqliteTest(
  "sqlite: subqueries (derived table, scalar, inArray)",
  async (db) => {
    // Derived table: per-org counts wrapped as `from (…) as counts`.
    const counts = db.select({ orgId: users.columns.orgId, n: count() })
      .from(users).where(isNotNull(users.columns.orgId))
      .groupBy(users.columns.orgId).as("counts");
    assertEquals(
      (await db.select({ orgId: counts.orgId, n: counts.n }).from(counts)
        .execute()).length,
      2,
    );

    // Scalar subquery in a projection.
    const scalar = await db.select({
      id: orgs.columns.id,
      members: db.select({ c: count() }).from(users)
        .where(eq(users.columns.orgId, orgs.columns.id)),
    }).from(orgs).orderBy(asc(orgs.columns.id)).execute();
    assertEquals(scalar.map((r) => Number(r.members)), [2, 1]);

    // inArray(col, subquery): users whose org is named "Acme".
    const acme = await db.select().from(users).where(
      inArray(
        users.columns.orgId,
        db.select({ id: orgs.columns.id }).from(orgs)
          .where(eq(orgs.columns.name, "Acme")),
      ),
    ).execute();
    assertEquals(acme.length, 2); // Alice + Bob (org 1)
  },
);

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

// ---- v0.4.0 features ------------------------------------------------------

sqliteTest(
  "sqlite: column naming (snake_case default, .named, preserve)",
  async (db) => {
    // camelCase JS keys map to snake_case physical columns by default; `.named`
    // pins an explicit name and `naming: "preserve"` keeps the key verbatim.
    const accounts = defineTable("it_accounts", {
      id: columns.integer().primaryKey(),
      fullName: columns.text(),
      hotScore: columns.doublePrecision(),
      legacyTag: columns.text().named("legacy"),
    });
    const legacyTable = defineTable("it_legacy", {
      id: columns.integer().primaryKey(),
      keepThis: columns.text(),
    }, { naming: "preserve" });

    for (
      const stmt of generateSqliteUpStatements(
        createSchemaSnapshot({
          dialect: "sqlite",
          tables: [accounts, legacyTable],
        }),
      ).statements
    ) {
      await db.execute(stmt);
    }

    const names = async (table: string) =>
      (await db.query<{ name: string }>(
        sql`select name from pragma_table_info(${table})`,
      )).rows.map((r) => r.name);

    assertEquals(await names("it_accounts"), [
      "id",
      "full_name",
      "hot_score",
      "legacy",
    ]);
    assertEquals(await names("it_legacy"), ["id", "keepThis"]);

    // Write through camelCase keys; read back keyed by camelCase property names.
    await db.insert(accounts).values({
      id: 1,
      fullName: "Ada",
      hotScore: 1.5,
      legacyTag: "L",
    }).execute();
    const [row] = await db.select().from(accounts)
      .where(eq(accounts.columns.id, 1)).execute();
    assertEquals(row.fullName, "Ada");
    assertEquals(Number(row.hotScore), 1.5);
    assertEquals(row.legacyTag, "L");

    // Updating through a camelCase key writes the snake_case column.
    await db.update(accounts).set({ hotScore: 2.5 })
      .where(eq(accounts.columns.id, 1)).execute();
    const [updated] = await db.select().from(accounts)
      .where(eq(accounts.columns.id, 1)).execute();
    assertEquals(Number(updated.hotScore), 2.5);
  },
);

sqliteTest("sqlite: keyset pagination (expanded + row-value)", async (db) => {
  const feed = defineTable("it_feed", {
    id: columns.integer().primaryKey(),
    score: columns.integer().notNull(),
  });
  await db.execute(
    generateSqliteUpStatements(
      createSchemaSnapshot({ dialect: "sqlite", tables: [feed] }),
    ).statements[0],
  );
  await db.insert(feed).values([
    { id: 1, score: 10 },
    { id: 2, score: 20 },
    { id: 3, score: 20 }, // tie with id 2 on score; id is the tiebreaker
    { id: 4, score: 5 },
    { id: 5, score: 15 },
  ]).execute();

  // Page through the whole feed (page size 2) and collect ids in order.
  const pageAll = async (form: "expanded" | "row-value"): Promise<number[]> => {
    const ids: number[] = [];
    let after: { score: number; id: number } | undefined;
    for (let i = 0; i < 10; i += 1) {
      const pageRows = await db.select().from(feed).keyset({
        orderBy: [desc(feed.columns.score), desc(feed.columns.id)],
        after,
        form,
      }).limit(2).execute();
      ids.push(...pageRows.rows.map((r) => Number(r.id)));
      if (pageRows.nextCursor === null) break;
      after = {
        score: Number(pageRows.nextCursor.score),
        id: Number(pageRows.nextCursor.id),
      };
    }
    return ids;
  };

  // score desc, id desc -> 3, 2 (score 20), 5 (15), 1 (10), 4 (5).
  assertEquals(await pageAll("expanded"), [3, 2, 5, 1, 4]);
  assertEquals(await pageAll("row-value"), [3, 2, 5, 1, 4]);
});

sqliteTest("sqlite: prepared statement binds placeholders", async (db) => {
  const byId = db.select().from(users)
    .where(eq(users.columns.id, placeholder("id"))).prepare();
  assertEquals((await byId.execute({ id: 1 })).length, 1);
  assertEquals((await byId.execute({ id: 999 })).length, 0);
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
