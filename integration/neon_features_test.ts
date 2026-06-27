/**
 * Neon (serverless PostgreSQL) feature/compatibility suite for `@sisal/neon`.
 *
 * Neon speaks the Postgres wire protocol over a WebSocket via
 * `jsr:@neon/serverless`, so the SQL surface matches `@sisal/pg`. The suite runs
 * against a connection given by `NEON_DATABASE_URL`:
 *
 *   # Against real Neon
 *   NEON_DATABASE_URL="postgres://user:pw@ep-xxx.neon.tech/db?sslmode=require" \
 *     deno test -A integration/neon_features_test.ts
 *
 *   # Against a local Postgres through docker/compose.yaml's neon-proxy
 *   NEON_DATABASE_URL="postgres://postgres:postgres@localhost/sisal" \
 *     NEON_WS_PROXY="localhost:5499" \
 *     deno test -A integration/neon_features_test.ts
 *
 * With no `NEON_DATABASE_URL` every test is skipped. Each `Deno.test` name maps
 * to a row in docs/neon-compatibility.md.
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
import { connect, createNeonMigrator, type NeonDatabase } from "@sisal/neon";
import { generatePostgresUpStatements } from "@sisal/neon/ddl";

function env(key: string): string | undefined {
  try {
    return (globalThis as {
      Deno?: { env: { get(k: string): string | undefined } };
    })
      .Deno?.env.get(key) ?? undefined;
  } catch {
    return undefined;
  }
}

const URL = env("NEON_DATABASE_URL");
const WS_PROXY = env("NEON_WS_PROXY");
const SKIP = URL === undefined;

// Point the serverless driver at a local insecure WebSocket proxy when testing
// against a plain Postgres (no effect against real Neon, which uses secure ws).
async function configureNeon(): Promise<void> {
  if (WS_PROXY === undefined) return;
  const mod = await import("@neon/serverless");
  const neonConfig = mod.neonConfig as unknown as Record<string, unknown>;
  neonConfig.wsProxy = () => `${WS_PROXY}/v1`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineTLS = false;
  neonConfig.pipelineConnect = false;
}

let dbHandle: NeonDatabase | undefined;
async function db(): Promise<NeonDatabase> {
  if (dbHandle === undefined) {
    await configureNeon();
    dbHandle = await connect({ url: URL! });
  }
  return dbHandle;
}

function neonTest(
  name: string,
  fn: (db: NeonDatabase) => Promise<void> | void,
) {
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

// ---- schema (same surface as the Postgres suite) --------------------------

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
  c_blob: columns.bytea(),
});

// ---------------------------------------------------------------------------

neonTest("neon: connect + raw parameterized query", async (db) => {
  const result = await db.query<{ one: number; who: string }>(
    sql`select 1 as one, ${"sisal"}::text as who`,
  );
  assertEquals(Number(result.rows[0].one), 1);
  assertEquals(result.rows[0].who, "sisal");
});

neonTest("neon: generated DDL applies (every column type)", async (db) => {
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
  const cols = await db.query<{ count: number }>(
    sql`select count(*)::int as count from information_schema.columns
        where table_name = ${"it_all_types"}`,
  );
  assertEquals(Number(cols.rows[0].count), 20);
});

neonTest("neon: insert + returning", async (db) => {
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

  assertEquals((await db.select().from(users).execute()).length, 4);
});

neonTest("neon: filter operators (incl. native ilike)", async (db) => {
  const len = async (
    cond: Parameters<ReturnType<typeof db.select>["where"]>[0],
  ) => (await db.select().from(users).where(cond).execute()).length;

  assertEquals(await len(eq(users.columns.id, 1)), 1);
  assertEquals(await len(ne(users.columns.id, 1)), 3);
  assertEquals(await len(gt(users.columns.age, 18)), 2);
  assertEquals(await len(gte(users.columns.age, 17)), 3);
  assertEquals(await len(lt(users.columns.age, 30)), 1);
  assertEquals(await len(lte(users.columns.age, 30)), 2);
  assertEquals(await len(like(users.columns.email, "a%")), 1);
  assertEquals(await len(ilike(users.columns.email, "A%")), 1);
  assertEquals(await len(notLike(users.columns.email, "a%")), 3);
  assertEquals(await len(notIlike(users.columns.email, "A%")), 3);
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
});

neonTest("neon: orderBy asc/desc + limit + offset", async (db) => {
  const rows = await db.select().from(users)
    .where(isNotNull(users.columns.age))
    .orderBy(desc(users.columns.age), asc(users.columns.email))
    .limit(2).offset(0).execute();
  assertEquals(rows.map((r) => r.id), [3, 1]);
});

neonTest("neon: distinct", async (db) => {
  const rows = await db.select({ orgId: users.columns.orgId }).from(users)
    .distinct().execute();
  assertEquals(rows.length, 3);
});

neonTest("neon: joins (inner / left / right / full)", async (db) => {
  const projection = { uid: users.columns.id, oid: orgs.columns.id };
  const inner = await db.select({
    u: users.columns.email,
    o: orgs.columns.name,
  })
    .from(users).innerJoin(orgs, eq(orgs.columns.id, users.columns.orgId))
    .execute();
  assertEquals(inner.length, 3);
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

neonTest("neon: aggregates + groupBy + having", async (db) => {
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

neonTest("neon: update + returning + $onUpdate", async (db) => {
  await db.insert(posts).values({
    id: 1,
    title: "first",
    body: { note: "n" },
    updatedAt: null,
  }).execute();
  const updated = await db.update(posts).set({ title: "renamed" })
    .where(eq(posts.columns.id, 1)).returning().execute();
  assertEquals(updated.rows[0].title, "renamed");
  assert(updated.rows[0].updatedAt !== null);
});

neonTest("neon: delete + returning", async (db) => {
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

neonTest(
  "neon: upsert (onConflictDoNothing / onConflictDoUpdate)",
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

neonTest("neon: transaction commit and rollback", async (db) => {
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

neonTest("neon: jsonb round-trip", async (db) => {
  const rows = await db.select({ body: posts.columns.body }).from(posts)
    .where(eq(posts.columns.id, 1)).execute();
  const body = rows[0].body as { note: string } | string;
  const parsed = typeof body === "string" ? JSON.parse(body) : body;
  assertEquals(parsed.note, "n");
});

neonTest("neon: text[] array round-trip", async (db) => {
  const rows = await db.select({ tags: users.columns.tags }).from(users)
    .where(eq(users.columns.id, 1)).execute();
  assertEquals(rows[0].tags, ["x", "y"]);
});

neonTest("neon: bytea binary round-trip", async (db) => {
  const bin = defineTable("it_bin", {
    id: columns.integer().primaryKey(),
    data: columns.bytea(),
  });
  await db.execute(
    generatePostgresUpStatements(
      createSchemaSnapshot({ dialect: "postgres", tables: [bin] }),
    ).statements[0],
  );
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  await db.insert(bin).values({ id: 1, data: bytes }).execute();
  const rows = await db.select({ data: bin.columns.data }).from(bin)
    .where(eq(bin.columns.id, 1)).execute();
  const value = rows[0].data as unknown as ArrayBuffer | Uint8Array;
  const out = value instanceof Uint8Array ? value : new Uint8Array(value);
  assertEquals(Array.from(out), [0, 1, 2, 250, 255]);
});

neonTest("neon: migrator applies, plans, and is idempotent", async () => {
  const migrator = await createNeonMigrator({
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
    const second = await migrator.migrate({ migrations: [migration] });
    assertEquals(second.executed.length, 0);
  } finally {
    await migrator.close();
  }
});

neonTest("neon: teardown", async (db) => {
  await db.execute(
    raw(
      "drop table if exists it_all_types, it_posts, it_users, it_orgs, it_bin, it_widget, it_history cascade",
    ),
  );
  await db.close();
  dbHandle = undefined;
});
