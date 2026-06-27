/**
 * PostgreSQL feature/compatibility suite for `@sisal/pg`.
 *
 * Runs against a real PostgreSQL server given by the `DATABASE_URL` env var and
 * exercises every adapter feature end-to-end. With no `DATABASE_URL` every test
 * is skipped, so this file is safe to keep out of the network-free unit run and
 * is driven by `scripts/pg-matrix.sh` / `docker/compose.yaml` across PG 16/17/18.
 *
 * Each `Deno.test` name maps to one row in docs/pg-compatibility.md.
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
  notIlike,
  notInArray,
  notLike,
  or,
  raw,
  sql,
  sum,
} from "@sisal/orm";
import { defineSqlMigration } from "@sisal/migrate";
import { connect, createPgMigrator, type PgDatabase } from "@sisal/pg";
import { generatePostgresUpStatements } from "@sisal/pg/ddl";

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

let dbHandle: PgDatabase | undefined;
async function db(): Promise<PgDatabase> {
  dbHandle ??= await connect({ url: URL! });
  return dbHandle;
}

function pgTest(name: string, fn: (db: PgDatabase) => Promise<void> | void) {
  Deno.test({
    name,
    ignore: SKIP,
    sanitizeResources: false,
    sanitizeOps: false,
    fn: async () => {
      await fn(await db());
    },
  });
}

// ---- schema used by the feature tests -------------------------------------

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
  tags: columns.text().array(),
  orgId: columns.integer(),
});

const posts = defineTable("it_posts", {
  id: columns.integer().primaryKey(),
  title: columns.text().notNull(),
  body: columns.jsonb<{ note: string }>(),
  updatedAt: columns.timestamp({ withTimezone: true })
    .$onUpdate(() => new Date("2020-01-01T00:00:00Z")),
});

// Exhaustive column-type table — exercises the generated DDL on each server.
const allTypes = defineTable("it_all_types", {
  id: columns.serial().primaryKey(),
  c_text: columns.text(),
  c_varchar: columns.varchar(50),
  c_char: columns.char(4),
  c_int: columns.integer(),
  c_smallint: columns.smallint(),
  c_bigint: columns.bigint(),
  c_bigserial: columns.bigserial(),
  c_numeric: columns.numeric(10, 2),
  c_real: columns.real(),
  c_double: columns.doublePrecision(),
  c_bool: columns.boolean(),
  c_json: columns.json(),
  c_jsonb: columns.jsonb(),
  c_date: columns.date(),
  c_ts: columns.timestamp(),
  c_tstz: columns.timestamp({ withTimezone: true }),
  c_uuid: columns.uuid(),
  c_text_arr: columns.text().array(),
});

// ---------------------------------------------------------------------------

pgTest("pg: connect + raw parameterized query", async (db) => {
  const result = await db.query<{ one: number; who: string }>(
    sql`select 1 as one, ${"sisal"}::text as who`,
  );
  assertEquals(Number(result.rows[0].one), 1);
  assertEquals(result.rows[0].who, "sisal");
});

pgTest("pg: generated DDL applies (every column type)", async (db) => {
  await db.execute(
    raw(
      "drop table if exists it_all_types, it_posts, it_users, it_orgs cascade",
    ),
  );

  const snapshot = createSchemaSnapshot({
    dialect: "postgres",
    tables: [orgs, users, posts, allTypes],
  });
  const { statements, destructive } = generatePostgresUpStatements(snapshot);
  assertEquals(destructive.length, 0);

  for (const statement of statements) {
    await db.execute(statement);
  }

  // Verify the exhaustive table really landed with all its columns.
  const cols = await db.query<{ count: number }>(
    sql`select count(*)::int as count from information_schema.columns
        where table_name = ${"it_all_types"}`,
  );
  assertEquals(Number(cols.rows[0].count), 19);
});

pgTest("pg: insert + returning", async (db) => {
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
    tags: ["x", "y"],
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
      tags: [],
      orgId: 1,
    },
    {
      id: 3,
      email: "c@example.com",
      name: "Cara",
      age: 41,
      active: true,
      score: "99.99",
      tags: ["z"],
      orgId: 2,
    },
    {
      id: 4,
      email: "d@example.com",
      name: null,
      age: null,
      active: null,
      score: null,
      tags: null,
      orgId: null,
    },
  ]).execute();

  const all = await db.select().from(users).execute();
  assertEquals(all.length, 4);
});

pgTest("pg: filter operators", async (db) => {
  const eqRows = await db.select().from(users).where(eq(users.columns.id, 1))
    .execute();
  assertEquals(eqRows.length, 1);

  assertEquals(
    (await db.select().from(users).where(ne(users.columns.id, 1)).execute())
      .length,
    3,
  );
  assertEquals(
    (await db.select().from(users).where(gt(users.columns.age, 18)).execute())
      .length,
    2,
  );
  assertEquals(
    (await db.select().from(users).where(gte(users.columns.age, 17)).execute())
      .length,
    3,
  );
  assertEquals(
    (await db.select().from(users).where(lt(users.columns.age, 30)).execute())
      .length,
    1,
  );
  assertEquals(
    (await db.select().from(users).where(lte(users.columns.age, 30)).execute())
      .length,
    2,
  );
  assertEquals(
    (await db.select().from(users).where(like(users.columns.email, "a%"))
      .execute()).length,
    1,
  );
  assertEquals(
    (await db.select().from(users).where(ilike(users.columns.email, "A%"))
      .execute()).length,
    1,
  );
  assertEquals(
    (await db.select().from(users).where(notLike(users.columns.email, "a%"))
      .execute()).length,
    3,
  );
  assertEquals(
    (await db.select().from(users).where(notIlike(users.columns.email, "A%"))
      .execute()).length,
    3,
  );
  assertEquals(
    (await db.select().from(users).where(between(users.columns.age, 18, 40))
      .execute()).length,
    1,
  );
  assertEquals(
    (await db.select().from(users).where(notBetween(users.columns.age, 18, 40))
      .execute()).length,
    2,
  );
  assertEquals(
    (await db.select().from(users).where(inArray(users.columns.id, [1, 2]))
      .execute()).length,
    2,
  );
  assertEquals(
    (await db.select().from(users).where(notInArray(users.columns.id, [1, 2]))
      .execute()).length,
    2,
  );
  assertEquals(
    (await db.select().from(users).where(isNull(users.columns.age)).execute())
      .length,
    1,
  );
  assertEquals(
    (await db.select().from(users).where(isNotNull(users.columns.age))
      .execute()).length,
    3,
  );
  assertEquals(
    (await db.select().from(users)
      .where(and(eq(users.columns.active, true), gt(users.columns.age, 20)))
      .execute()).length,
    2,
  );
  assertEquals(
    (await db.select().from(users)
      .where(or(eq(users.columns.id, 1), eq(users.columns.id, 2)))
      .execute()).length,
    2,
  );
  assertEquals(
    (await db.select().from(users).where(not(eq(users.columns.id, 1)))
      .execute()).length,
    3,
  );
});

pgTest("pg: orderBy asc/desc + limit + offset", async (db) => {
  const rows = await db.select().from(users)
    .where(isNotNull(users.columns.age))
    .orderBy(desc(users.columns.age), asc(users.columns.email))
    .limit(2)
    .offset(0)
    .execute();
  assertEquals(rows.map((r) => r.id), [3, 1]);
});

pgTest("pg: distinct", async (db) => {
  const rows = await db.select({ orgId: users.columns.orgId }).from(users)
    .distinct().execute();
  // orgIds present: 1, 1, 2, null -> distinct {1, 2, null}
  assertEquals(rows.length, 3);
});

pgTest("pg: joins (inner / left / right / full)", async (db) => {
  // Joins use explicit aliased projections: `select *` across tables that share
  // column names (id/name) breaks the @db/postgres row-object mapper.
  const projection = { uid: users.columns.id, oid: orgs.columns.id };

  const inner = await db.select({
    u: users.columns.email,
    o: orgs.columns.name,
  })
    .from(users).innerJoin(orgs, eq(orgs.columns.id, users.columns.orgId))
    .execute();
  assertEquals(inner.length, 3); // user 4 has null orgId -> excluded

  const left = await db.select(projection).from(users)
    .leftJoin(orgs, eq(orgs.columns.id, users.columns.orgId)).execute();
  assertEquals(left.length, 4);

  const right = await db.select(projection).from(users)
    .rightJoin(orgs, eq(orgs.columns.id, users.columns.orgId)).execute();
  assert(right.length >= 3);

  const full = await db.select(projection).from(users)
    .fullJoin(orgs, eq(orgs.columns.id, users.columns.orgId)).execute();
  assert(full.length >= 4);
});

pgTest("pg: aggregates + groupBy + having", async (db) => {
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

  assertEquals(grouped.length, 1); // org 1 has 2 users, org 2 has 1
  assertEquals(Number(grouped[0].n), 2);
  assert(Number(grouped[0].total) > 0);
});

pgTest("pg: update + returning + $onUpdate", async (db) => {
  // updatedAt is managed by $onUpdate (only on UPDATE), so it's null on insert.
  await db.insert(posts).values({
    id: 1,
    title: "first",
    body: { note: "n" },
    updatedAt: null,
  }).execute();
  const updated = await db.update(posts).set({ title: "renamed" })
    .where(eq(posts.columns.id, 1)).returning().execute();
  assertEquals(updated.rows[0].title, "renamed");
  // $onUpdate injected the fixed timestamp even though we didn't set it.
  assert(updated.rows[0].updatedAt !== null);
});

pgTest("pg: delete + returning", async (db) => {
  await db.insert(users).values({
    id: 99,
    email: "tmp@example.com",
    name: "Temp",
    age: 50,
    active: true,
    score: "1.00",
    tags: [],
    orgId: 1,
  }).execute();
  const removed = await db.delete(users).where(eq(users.columns.id, 99))
    .returning().execute();
  assertEquals(removed.rows[0].id, 99);
});

pgTest("pg: upsert (onConflictDoNothing / onConflictDoUpdate)", async (db) => {
  await db.insert(orgs).values({ id: 1, name: "Acme dup" })
    .onConflictDoNothing({ target: orgs.columns.id }).execute();
  const afterNothing = await db.select().from(orgs)
    .where(eq(orgs.columns.id, 1)).execute();
  assertEquals(afterNothing[0].name, "Acme"); // unchanged

  await db.insert(orgs).values({ id: 1, name: "ignored" })
    .onConflictDoUpdate({ target: orgs.columns.id, set: { name: "Acme v2" } })
    .execute();
  const afterUpdate = await db.select().from(orgs)
    .where(eq(orgs.columns.id, 1)).execute();
  assertEquals(afterUpdate[0].name, "Acme v2");
});

pgTest("pg: transaction commit and rollback", async (db) => {
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

pgTest("pg: jsonb round-trip", async (db) => {
  const rows = await db.select({ body: posts.columns.body }).from(posts)
    .where(eq(posts.columns.id, 1)).execute();
  const body = rows[0].body as { note: string } | string;
  const parsed = typeof body === "string" ? JSON.parse(body) : body;
  assertEquals(parsed.note, "n");
});

pgTest("pg: text[] array round-trip", async (db) => {
  const rows = await db.select({ tags: users.columns.tags }).from(users)
    .where(eq(users.columns.id, 1)).execute();
  assertEquals(rows[0].tags, ["x", "y"]);
});

pgTest("pg: migrator applies, plans, and is idempotent", async (db) => {
  void db;
  const migrator = await createPgMigrator({
    url: URL!,
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

    // Re-running applies nothing (history is durable).
    const second = await migrator.migrate({ migrations: [migration] });
    assertEquals(second.executed.length, 0);
  } finally {
    await migrator.close();
  }
});

pgTest("pg: teardown", async (db) => {
  await db.execute(
    raw(
      "drop table if exists it_all_types, it_posts, it_users, it_orgs, it_widget, it_history cascade",
    ),
  );
  await db.close();
  dbHandle = undefined;
});
