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
import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
} from "@std/assert";
import {
  and,
  arrayContained,
  arrayContains,
  arrayOverlaps,
  asc,
  avg,
  between,
  columns,
  count,
  countDistinct,
  createSchemaSnapshot,
  dateBin,
  dateSub,
  dateTrunc,
  defineAtomicOperation,
  defineFunction,
  defineTable,
  desc,
  eq,
  exists,
  filter,
  gt,
  gte,
  ilike,
  inArray,
  index,
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
  notIlike,
  notInArray,
  notLike,
  now,
  or,
  placeholder,
  raw,
  schemaObjectDropStatements,
  sql,
  sum,
  uniqueIndex,
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

let temporalDbHandle: PgDatabase | undefined;
async function temporalDb(): Promise<PgDatabase> {
  temporalDbHandle ??= await connect({
    url: URL!,
    temporal: { parse: true },
  });
  return temporalDbHandle;
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
  updatedAt: columns.timestamp({ withTimezone: true, mode: "date" })
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
  c_time: columns.time(),
  c_ts: columns.timestamp(),
  c_tstz: columns.timestamp({ withTimezone: true }),
  c_uuid: columns.uuid(),
  c_text_arr: columns.text().array(),
  c_blob: columns.bytea(),
});

const temporalValues = defineTable("it_temporal_values", {
  id: columns.integer().primaryKey(),

  plain_date: columns.date(),
  plain_time: columns.time(),
  plain_timestamp: columns.timestamp(),
  instant_timestamp: columns.timestamp({ withTimezone: true }),

  date_text: columns.date({ mode: "string" }),
  time_text: columns.time({ mode: "string" }),
  timestamp_text: columns.timestamp({ mode: "string" }),
  instant_text: columns.timestamp({ withTimezone: true, mode: "string" }),

  legacy_date: columns.date({ mode: "date" }),
  legacy_timestamp: columns.timestamp({ mode: "date" }),
  legacy_instant: columns.timestamp({ withTimezone: true, mode: "date" }),
});

const plainTimestampPrefix = "2026-06-28T12:34:56.123";
const plainTimestampDateFallbackPrefix = new Date(
  "2026-06-28T12:34:56.123456",
).toISOString().replace("Z", "").slice(0, 23);

function assertTemporalRow(row: Record<string, unknown>): void {
  assertInstanceOf(row.plain_date, Temporal.PlainDate);
  assertEquals(row.plain_date.toString(), "2026-06-28");

  assertInstanceOf(row.plain_time, Temporal.PlainTime);
  assertTimePrefix(row.plain_time.toString(), "12:34:56.123");

  assertInstanceOf(row.plain_timestamp, Temporal.PlainDateTime);
  assertPlainTimestampPrefix(row.plain_timestamp.toString());

  assertInstanceOf(row.instant_timestamp, Temporal.Instant);
  assert(
    row.instant_timestamp.toString().startsWith("2026-06-28T12:34:56.123"),
    row.instant_timestamp.toString(),
  );

  assertString(row.date_text);
  assertEquals(row.date_text, "2026-06-28");
  assertTimePrefix(row.time_text, "12:34:56.123");

  assertString(row.timestamp_text);
  assertPlainTimestampPrefix(row.timestamp_text);

  assertString(row.instant_text);
  assert(
    row.instant_text.startsWith("2026-06-28T12:34:56.123") ||
      row.instant_text.startsWith("2026-06-28 12:34:56.123"),
    row.instant_text,
  );
}

function assertNotTemporal(value: unknown): void {
  assert(!(value instanceof Temporal.PlainDate));
  assert(!(value instanceof Temporal.PlainTime));
  assert(!(value instanceof Temporal.PlainDateTime));
  assert(!(value instanceof Temporal.Instant));
  assert(!(value instanceof Temporal.ZonedDateTime));
}

function assertString(value: unknown): asserts value is string {
  assertEquals(typeof value, "string");
}

function assertTimePrefix(value: unknown, prefix: string): void {
  assertString(value);
  assert(value.startsWith(prefix), value);
}

function assertPlainTimestampPrefix(value: string): void {
  assert(
    value.startsWith(plainTimestampPrefix) ||
      value.startsWith(plainTimestampPrefix.replace("T", " ")) ||
      value.startsWith(plainTimestampDateFallbackPrefix),
    value,
  );
}

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
  assertEquals(Number(cols.rows[0].count), 21);
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

pgTest("pg: Temporal date/time modes", async (db) => {
  const parsed = await temporalDb();

  await db.execute(raw("drop table if exists it_temporal_values cascade"));

  const snapshot = createSchemaSnapshot({
    dialect: "postgres",
    tables: [temporalValues],
  });
  const { statements, destructive } = generatePostgresUpStatements(snapshot);
  assertEquals(destructive.length, 0);
  for (const statement of statements) {
    await db.execute(statement);
  }

  const inserted = await parsed.insert(temporalValues).values({
    id: 1,
    plain_date: Temporal.PlainDate.from("2026-06-28"),
    plain_time: Temporal.PlainTime.from("12:34:56.123456"),
    plain_timestamp: Temporal.PlainDateTime.from(
      "2026-06-28T12:34:56.123456",
    ),
    instant_timestamp: Temporal.Instant.from(
      "2026-06-28T12:34:56.123456Z",
    ),
    date_text: "2026-06-28",
    time_text: "12:34:56.123456",
    timestamp_text: "2026-06-28T12:34:56.123456",
    instant_text: "2026-06-28T12:34:56.123456Z",
    legacy_date: null,
    legacy_timestamp: null,
    legacy_instant: null,
  }).returning().execute();
  assertTemporalRow(inserted.rows[0] as Record<string, unknown>);

  const [unparsed] = await db.select().from(temporalValues)
    .where(eq(temporalValues.columns.id, 1))
    .execute();
  for (
    const key of [
      "plain_date",
      "plain_time",
      "plain_timestamp",
      "instant_timestamp",
      "date_text",
      "time_text",
      "timestamp_text",
      "instant_text",
    ]
  ) {
    assertNotTemporal((unparsed as Record<string, unknown>)[key]);
  }

  await db.query(
    sql`insert into it_temporal_values
        (id, legacy_date, legacy_timestamp, legacy_instant)
        values (
          ${2},
          ${"2026-06-28"},
          ${"2026-06-28T12:34:56.123456"},
          ${"2026-06-28T12:34:56.123456Z"}
        )`,
  );

  const [legacy] = await parsed.select({
    legacy_date: temporalValues.columns.legacy_date,
    legacy_timestamp: temporalValues.columns.legacy_timestamp,
    legacy_instant: temporalValues.columns.legacy_instant,
  }).from(temporalValues)
    .where(eq(temporalValues.columns.id, 2))
    .execute();
  assertNotTemporal(legacy.legacy_date);
  assertNotTemporal(legacy.legacy_timestamp);
  assertNotTemporal(legacy.legacy_instant);

  const rawResult = await parsed.query<{ plain_date: unknown }>(
    sql`select ${"2026-06-28"} as plain_date`,
  );
  assertEquals(rawResult.rows[0].plain_date, "2026-06-28");

  const zoned = Temporal.ZonedDateTime.from(
    "2026-06-28T09:34:56.123456-03:00[America/Fortaleza]",
  );
  const zonedResult = await parsed.query<{ value: unknown }>(
    sql`select ${zoned} as value`,
  );
  assertNotTemporal(zonedResult.rows[0].value);
  assertString(zonedResult.rows[0].value);
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

pgTest("pg: $count + countDistinct", async (db) => {
  assertEquals(await db.$count(users), 4);
  assertEquals(await db.$count(users, isNotNull(users.columns.age)), 3);

  const distinct = await db
    .select({ orgs: countDistinct(users.columns.orgId) })
    .from(users).execute();
  assertEquals(Number(distinct[0].orgs), 2); // org ids {1, 2}; null excluded
});

pgTest("pg: exists / notExists (correlated subquery)", async (db) => {
  const withUsers = db.select({ one: users.columns.id }).from(users)
    .where(eq(users.columns.orgId, orgs.columns.id));
  assertEquals(
    (await db.select().from(orgs).where(exists(withUsers)).execute()).length,
    2,
  );
  assertEquals(
    (await db.select().from(orgs).where(notExists(withUsers)).execute()).length,
    0,
  );
});

pgTest("pg: subqueries (derived table, scalar, inArray)", async (db) => {
  const counts = db.select({ orgId: users.columns.orgId, n: count() })
    .from(users).where(isNotNull(users.columns.orgId))
    .groupBy(users.columns.orgId).as("counts");
  assertEquals(
    (await db.select({ orgId: counts.orgId, n: counts.n }).from(counts)
      .execute()).length,
    2,
  );

  const scalar = await db.select({
    id: orgs.columns.id,
    members: db.select({ c: count() }).from(users)
      .where(eq(users.columns.orgId, orgs.columns.id)),
  }).from(orgs).orderBy(asc(orgs.columns.id)).execute();
  assertEquals(scalar.map((r) => Number(r.members)), [2, 1]);

  const acme = await db.select().from(users).where(
    inArray(
      users.columns.orgId,
      db.select({ id: orgs.columns.id }).from(orgs)
        .where(eq(orgs.columns.name, "Acme")),
    ),
  ).execute();
  assertEquals(acme.length, 2); // Alice + Bob (org 1)
});

pgTest("pg: distinctOn (SELECT DISTINCT ON)", async (db) => {
  // One row per org, picking the lowest user id within each org.
  const rows = await db
    .select({ orgId: users.columns.orgId, id: users.columns.id })
    .from(users)
    .where(isNotNull(users.columns.orgId))
    .distinctOn(users.columns.orgId)
    .orderBy(asc(users.columns.orgId), asc(users.columns.id))
    .execute();
  assertEquals(rows.map((r) => [Number(r.orgId), Number(r.id)]), [[1, 1], [
    2,
    3,
  ]]);
});

pgTest("pg: for update / skip locked row locking", async (db) => {
  await db.transaction(async (tx) => {
    const locked = await tx.select().from(users)
      .where(eq(users.columns.id, 1)).for("update").execute();
    assertEquals(locked.length, 1);

    const skipped = await tx.select().from(users)
      .where(eq(users.columns.id, 2)).for("update", { skipLocked: true })
      .execute();
    assertEquals(skipped.length, 1);
  });
});

pgTest("pg: array operators (@> / <@ / &&)", async (db) => {
  // tags: id1 ["x","y"], id2 [], id3 ["z"], id4 null.
  const contains = await db.select().from(users)
    .where(arrayContains(users.columns.tags, ["x"])).execute();
  assertEquals(contains.map((r) => r.id), [1]);

  const contained = await db.select().from(users)
    .where(arrayContained(users.columns.tags, ["x", "y", "z"]))
    .orderBy(asc(users.columns.id)).execute();
  assertEquals(contained.map((r) => r.id), [1, 2, 3]); // subsets; null excluded

  const overlaps = await db.select().from(users)
    .where(arrayOverlaps(users.columns.tags, ["z", "q"])).execute();
  assertEquals(overlaps.map((r) => r.id), [3]);
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

pgTest("pg: bytea binary round-trip", async (db) => {
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
  const raw = rows[0].data as unknown as ArrayBuffer | Uint8Array;
  const out = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  assertEquals(Array.from(out), [0, 1, 2, 250, 255]);
});

pgTest("pg: float4 / float8 read back as number", async (db) => {
  const floats = defineTable("it_floats", {
    id: columns.integer().primaryKey(),
    f4: columns.real(),
    f8: columns.doublePrecision(),
  });
  await db.execute(raw("drop table if exists it_floats cascade"));
  await db.execute(
    generatePostgresUpStatements(
      createSchemaSnapshot({ dialect: "postgres", tables: [floats] }),
    ).statements[0],
  );
  await db.insert(floats).values({ id: 1, f4: 1.5, f8: 306.25 }).execute();

  // `@db/postgres` decodes float4/float8 to strings; the adapter coerces them
  // back to `number` so the inferred type matches the runtime value.
  const [row] = await db.select().from(floats)
    .where(eq(floats.columns.id, 1)).execute();
  assertEquals(typeof row.f4, "number");
  assertEquals(typeof row.f8, "number");
  assertEquals(row.f4, 1.5);
  assertEquals(row.f8, 306.25);

  // Raw-query reads coerce too.
  const rawRead = await db.query<{ v: number }>(
    sql`select 180.5::double precision as v`,
  );
  assertEquals(typeof rawRead.rows[0].v, "number");
  assertEquals(rawRead.rows[0].v, 180.5);

  // `numeric` stays a precision-preserving string (not a float).
  const numeric = await db.query<{ n: string }>(
    sql`select 306.25::numeric as n`,
  );
  assertEquals(typeof numeric.rows[0].n, "string");
});

// ---- v0.4.0 features ------------------------------------------------------

pgTest(
  "pg: column naming (snake_case default, .named, preserve)",
  async (db) => {
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

    await db.execute(
      raw("drop table if exists it_accounts, it_legacy cascade"),
    );
    for (
      const stmt of generatePostgresUpStatements(
        createSchemaSnapshot({
          dialect: "postgres",
          tables: [accounts, legacyTable],
        }),
      ).statements
    ) {
      await db.execute(stmt);
    }

    const names = async (table: string) =>
      (await db.query<{ column_name: string }>(
        sql`select column_name from information_schema.columns
            where table_name = ${table} order by ordinal_position`,
      )).rows.map((r) => r.column_name);

    assertEquals(await names("it_accounts"), [
      "id",
      "full_name",
      "hot_score",
      "legacy",
    ]);
    assertEquals(await names("it_legacy"), ["id", "keepThis"]);

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

    await db.update(accounts).set({ hotScore: 2.5 })
      .where(eq(accounts.columns.id, 1)).execute();
    const [updated] = await db.select().from(accounts)
      .where(eq(accounts.columns.id, 1)).execute();
    assertEquals(Number(updated.hotScore), 2.5);
  },
);

pgTest("pg: keyset pagination (expanded + row-value)", async (db) => {
  const feed = defineTable("it_feed", {
    id: columns.integer().primaryKey(),
    score: columns.integer().notNull(),
  });
  await db.execute(raw("drop table if exists it_feed cascade"));
  await db.execute(
    generatePostgresUpStatements(
      createSchemaSnapshot({ dialect: "postgres", tables: [feed] }),
    ).statements[0],
  );
  await db.insert(feed).values([
    { id: 1, score: 10 },
    { id: 2, score: 20 },
    { id: 3, score: 20 }, // tie with id 2 on score; id is the tiebreaker
    { id: 4, score: 5 },
    { id: 5, score: 15 },
  ]).execute();

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

  assertEquals(await pageAll("expanded"), [3, 2, 5, 1, 4]);
  assertEquals(await pageAll("row-value"), [3, 2, 5, 1, 4]);
});

pgTest(
  "pg: typed function caller (RETURNS TABLE + scalar + casts)",
  async (db) => {
    await db.execute(raw(
      "create or replace function it_add(a integer, b integer) returns integer" +
        " language sql immutable as $$ select a + b $$",
    ));
    await db.execute(raw(
      "create or replace function it_pair(n integer)" +
        " returns table(lo integer, hi integer)" +
        " language sql immutable as $$ select n, n * 10 $$",
    ));
    await db.execute(raw(
      "create or replace function it_echo_uuid(u uuid) returns uuid" +
        " language sql immutable as $$ select u $$",
    ));
    await db.execute(raw(
      "create or replace function it_nums() returns table(v integer)" +
        " language sql immutable as $$ select v from (values (1),(2)) t(v) $$",
    ));

    // Scalar return: rendered `select it_add($1::integer, $2::integer) as result`.
    const add = defineFunction("it_add", {
      args: { a: columns.integer(), b: columns.integer() },
      returns: columns.integer(),
    });
    assertEquals(Number(await db.call(add, { a: 2, b: 3 }).one()), 5);

    // RETURNS TABLE: rendered `select * from it_pair($1::integer)`.
    const pair = defineFunction("it_pair", {
      args: { n: columns.integer() },
      returns: { lo: columns.integer(), hi: columns.integer() },
    });
    const [row] = await db.call(pair, { n: 4 }).execute();
    assertEquals(Number(row.lo), 4);
    assertEquals(Number(row.hi), 40);

    // The `::uuid` cast comes from the declared arg column type, not a string.
    const echo = defineFunction("it_echo_uuid", {
      args: { u: columns.uuid() },
      returns: columns.uuid(),
    });
    const uuid = crypto.randomUUID();
    assertEquals(await db.call(echo, { u: uuid }).one(), uuid);

    // No-arg, set-returning: execute() yields all rows; one() rejects 2 rows.
    const nums = defineFunction("it_nums", {
      returns: { v: columns.integer() },
    });
    assertEquals(
      (await db.call(nums, {}).execute()).map((r) => Number(r.v)),
      [1, 2],
    );
    await assertRejects(() => db.call(nums, {}).one());
  },
);

pgTest("pg: prepared statement binds placeholders", async (db) => {
  const byId = db.select().from(users)
    .where(eq(users.columns.id, placeholder("id"))).prepare();
  assertEquals((await byId.execute({ id: 1 })).length, 1);
  assertEquals((await byId.execute({ id: 999 })).length, 0);
});

pgTest("pg: sql expressions in SET / VALUES / onConflict", async (db) => {
  const expr = defineTable("it_expr", {
    id: columns.integer().primaryKey(),
    label: columns.text().notNull(),
    score: columns.integer().notNull(),
    upvotes: columns.integer().notNull(),
    downvotes: columns.integer().notNull(),
  });
  await db.execute(raw("drop table if exists it_expr cascade"));
  for (
    const stmt of generatePostgresUpStatements(
      createSchemaSnapshot({ dialect: "postgres", tables: [expr] }),
    ).statements
  ) {
    await db.execute(stmt);
  }
  const get = async () =>
    (await db.select().from(expr).where(eq(expr.columns.id, 1)).execute())[0];

  // INSERT: a `sql` expression renders inline and is evaluated by the server
  // (abs(-5) -> 5); the literal values still bind as parameters.
  await db.insert(expr).values({
    id: 1,
    label: "hi",
    score: sql`abs(-5)`,
    upvotes: 3,
    downvotes: 1,
  }).execute();
  const row = await get();
  assertEquals(Number(row.score), 5);
  assertEquals(row.label, "hi");

  // UPDATE SET computed from other columns: score = upvotes - downvotes.
  await db.update(expr).set({
    score: sql`${expr.columns.upvotes} - ${expr.columns.downvotes}`,
  }).where(eq(expr.columns.id, 1)).execute();
  assertEquals(Number((await get()).score), 2);

  // UPDATE SET calling a SQL function on a column: label = upper(label).
  await db.update(expr).set({ label: sql`upper(${expr.columns.label})` })
    .where(eq(expr.columns.id, 1)).execute();
  assertEquals((await get()).label, "HI");

  // ON CONFLICT DO UPDATE with a `sql` expression: score = score + 10.
  await db.insert(expr).values({
    id: 1,
    label: "x",
    score: 0,
    upvotes: 0,
    downvotes: 0,
  }).onConflictDoUpdate({
    target: expr.columns.id,
    set: { score: sql`${expr.columns.score} + 10` },
  }).execute();
  assertEquals(Number((await get()).score), 12);
});

pgTest(
  "pg: batch runs statements atomically (commit + rollback)",
  async (db) => {
    const batchT = defineTable("it_batch", {
      id: columns.integer().primaryKey(),
      score: columns.integer().notNull(),
    });
    await db.execute(raw("drop table if exists it_batch cascade"));
    for (
      const stmt of generatePostgresUpStatements(
        createSchemaSnapshot({ dialect: "postgres", tables: [batchT] }),
      ).statements
    ) {
      await db.execute(stmt);
    }
    const all = async () => (await db.select().from(batchT).orderBy(
      asc(batchT.columns.id),
    ).execute());

    // A batch of independent writes commits together; one result per statement.
    const results = await db.batch([
      db.insert(batchT).values({ id: 1, score: 10 }),
      db.insert(batchT).values({ id: 2, score: 20 }),
      db.update(batchT).set({ score: sql`${batchT.columns.score} + 5` })
        .where(eq(batchT.columns.id, 1)),
    ]);
    assertEquals(results.length, 3);
    assertEquals((await all()).map((r) => [Number(r.id), Number(r.score)]), [
      [1, 15],
      [2, 20],
    ]);

    // A failing statement (duplicate PK) rolls the whole batch back: the row that
    // would have been inserted before it is not persisted.
    await assertRejects(() =>
      db.batch([
        db.insert(batchT).values({ id: 3, score: 30 }),
        db.insert(batchT).values({ id: 1, score: 99 }), // PK collision
      ])
    );
    assertEquals((await all()).map((r) => Number(r.id)), [1, 2]);
  },
);

pgTest("pg: rich indexes (DESC / partial / expression) apply", async (db) => {
  await db.execute(raw("drop table if exists it_rich_idx cascade"));
  const richIdx = defineTable("it_rich_idx", {
    id: columns.integer().primaryKey(),
    status: columns.text(),
    hotScore: columns.integer(),
    createdAt: columns.timestamp(),
    email: columns.text(),
  }, (t) => [
    index("it_rich_hot")
      .where(sql`${t.status} = 'published'`)
      .on(desc(t.hotScore), desc(t.createdAt), desc(t.id)),
    uniqueIndex("it_rich_lower_email").on(sql`lower(${t.email})`),
  ]);
  const { statements } = generatePostgresUpStatements(
    createSchemaSnapshot({ dialect: "postgres", tables: [richIdx] }),
  );
  // The engine must accept the DESC / partial-WHERE / expression-index SQL.
  for (const statement of statements) await db.execute(statement);

  const defs = await db.query<{ indexdef: string }>(
    sql`select indexdef from pg_indexes where tablename = ${"it_rich_idx"}
        order by indexname`,
  );
  const all = defs.rows.map((row) => row.indexdef).join("\n");
  assert(/DESC/.test(all), all);
  assert(/WHERE.*status/i.test(all), all);
  assert(/lower/i.test(all), all);
});

pgTest("pg: mutation joins (UPDATE FROM + INSERT SELECT)", async (db) => {
  await db.execute(raw("drop table if exists it_mj, it_mj_arch cascade"));
  const mj = defineTable("it_mj", {
    id: columns.integer().primaryKey(),
    n: columns.integer().notNull(),
  });
  const arch = defineTable("it_mj_arch", {
    id: columns.integer().primaryKey(),
    n: columns.integer().notNull(),
  });
  for (
    const stmt of generatePostgresUpStatements(
      createSchemaSnapshot({ dialect: "postgres", tables: [mj, arch] }),
    ).statements
  ) await db.execute(stmt);

  await db.insert(mj).values([
    { id: 1, n: 10 },
    { id: 2, n: 20 },
    { id: 3, n: 30 },
  ]).execute();

  // UPDATE … FROM a CTE, via the mutating terminal of db.with(...): zero the
  // rows a CTE selects.
  const big = db.$with("big").as(
    db.select({ id: mj.columns.id }).from(mj).where(gte(mj.columns.n, 20)),
  );
  // Explicit RETURNING (not `*`): with a FROM join, `RETURNING *` would expose
  // both relations' `id` columns and the driver rejects the duplicate.
  const updated = await db.with(big).update(mj).set({ n: 0 })
    .from(big).where(eq(mj.columns.id, big.id))
    .returning({ id: mj.columns.id }).execute();
  assertEquals(updated.rows.length, 2); // ids 2, 3

  const zeroed = await db.select().from(mj).where(eq(mj.columns.n, 0))
    .execute();
  assertEquals(zeroed.map((r) => r.id).sort(), [2, 3]);

  // INSERT … SELECT: archive the zeroed rows from a query, not literal values.
  await db.insert(arch).select(
    db.select({ id: mj.columns.id, n: mj.columns.n }).from(mj)
      .where(eq(mj.columns.n, 0)),
  ).execute();
  assertEquals((await db.select().from(arch).execute()).length, 2);
});

pgTest("pg: data-modifying CTE (WITH INSERT … RETURNING)", async (db) => {
  const dmcte = defineTable("it_dmcte", {
    id: columns.integer().primaryKey(),
    msg: columns.text().notNull(),
  });
  await db.execute(raw("drop table if exists it_dmcte cascade"));
  await db.execute(
    generatePostgresUpStatements(
      createSchemaSnapshot({ dialect: "postgres", tables: [dmcte] }),
    ).statements[0],
  );

  // One statement: an INSERT inside a WITH, exposing its RETURNING to the
  // terminal SELECT — Postgres-only, single round trip.
  const inserted = db.$with("inserted").as(
    db.insert(dmcte).values({ id: 1, msg: "hello" }).returning(),
  );
  const rows = await db.with(inserted)
    .select({ id: inserted.id, msg: inserted.msg }).from(inserted).execute();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].msg, "hello");

  // The CTE actually persisted the row.
  assertEquals((await db.select().from(dmcte).execute()).length, 1);
});

pgTest("pg: atomic operation (transaction script)", async (db) => {
  const counters = defineTable("it_counters", {
    id: columns.integer().primaryKey(),
    n: columns.integer().notNull(),
  });
  await db.execute(raw("drop table if exists it_counters cascade"));
  await db.execute(
    generatePostgresUpStatements(
      createSchemaSnapshot({ dialect: "postgres", tables: [counters] }),
    ).statements[0],
  );

  // A dependent read-modify-write authored once; runs as one transaction.
  const bump = defineAtomicOperation<{ id: number }, number>(
    "bump",
    async (tx, { id }) => {
      const existing = await tx.select().from(counters)
        .where(eq(counters.columns.id, id)).execute();
      if (existing.length === 0) {
        await tx.insert(counters).values({ id, n: 1 }).execute();
        return 1;
      }
      const next = Number(existing[0].n) + 1;
      await tx.update(counters).set({ n: next })
        .where(eq(counters.columns.id, id)).execute();
      return next;
    },
  );
  assertEquals(await bump.run(db, { id: 1 }), 1);
  assertEquals(await bump.run(db, { id: 1 }), 2);

  // A throwing operation rolls its whole step back.
  const bumpThenFail = defineAtomicOperation<{ id: number }, never>(
    "bump_then_fail",
    async (tx, { id }) => {
      await tx.update(counters).set({ n: sql`${counters.columns.n} + 100` })
        .where(eq(counters.columns.id, id)).execute();
      throw new Error("boom");
    },
  );
  await assertRejects(() => bumpThenFail.run(db, { id: 1 }));
  const [row] = await db.select().from(counters)
    .where(eq(counters.columns.id, 1)).execute();
  assertEquals(Number(row.n), 2);
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

pgTest("pg: typed raw-query mapping (.as)", async (db) => {
  await db.execute(raw("drop table if exists it_rawmap cascade"));
  const t = defineTable("it_rawmap", {
    id: columns.integer().primaryKey(),
    hotScore: columns.integer(),
    createdAt: columns.timestamp({ mode: "string" }),
  });
  for (
    const stmt of generatePostgresUpStatements(
      createSchemaSnapshot({ dialect: "postgres", tables: [t] }),
    ).statements
  ) await db.execute(stmt);

  await db.insert(t).values({
    id: 1,
    hotScore: 42,
    createdAt: "2026-01-01 09:00:00",
  }).execute();

  // The raw row is keyed by physical column names...
  const rawResult = await db.query(raw("select * from it_rawmap"));
  assert("hot_score" in (rawResult.rows[0] as Record<string, unknown>));

  // ...and `.as(model)` maps it to the table's JS property keys + row type.
  const rows = await db.query(raw("select * from it_rawmap")).as(t);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].id, 1);
  assertEquals(rows[0].hotScore, 42);

  // The same row mapped via a free-form column map (no defineTable needed).
  const viaMap = await db.query(raw("select * from it_rawmap"))
    .as<{ id: number; hot: number }>({ id: {}, hot: { name: "hot_score" } });
  assertEquals(viaMap[0].hot, 42);
});

pgTest("pg: date math window (now / dateSub / dateBin)", async (db) => {
  await db.execute(raw("drop table if exists it_dm, it_dmbin cascade"));
  const win = defineTable("it_dm", {
    id: columns.integer().primaryKey(),
    score: columns.integer().notNull(),
    at: columns.timestamp({ withTimezone: true, mode: "string" }),
  });
  const bin = defineTable("it_dmbin", {
    id: columns.integer().primaryKey(),
    at: columns.timestamp({ withTimezone: true, mode: "string" }),
  });
  for (
    const stmt of generatePostgresUpStatements(
      createSchemaSnapshot({ dialect: "postgres", tables: [win, bin] }),
    ).statements
  ) await db.execute(stmt);

  // Buckets pinned to the DB's own clock, so the moving window below is
  // deterministic regardless of wall-clock or timezone.
  await db.insert(win).values([
    { id: 1, score: 10, at: dateSub(now(), { minutes: 2 }) },
    { id: 2, score: 5, at: dateSub(now(), { minutes: 30 }) },
    { id: 3, score: 3, at: dateSub(now(), { minutes: 90 }) },
  ]).execute();

  // The rising-score moving window, builder-native: conditional sums over
  // now()-relative cutoffs (filter + dateSub + now together).
  const [w] = await db.select({
    last15: filter(
      sum(win.columns.score),
      gte(win.columns.at, dateSub(now(), { minutes: 15 })),
    ),
    last60: filter(
      sum(win.columns.score),
      gte(win.columns.at, dateSub(now(), { minutes: 60 })),
    ),
    last120: filter(
      sum(win.columns.score),
      gte(win.columns.at, dateSub(now(), { minutes: 120 })),
    ),
  }).from(win).execute();
  assertEquals(Number(w.last15), 10); // only the 2-minute bucket
  assertEquals(Number(w.last60), 15); // 2m + 30m
  assertEquals(Number(w.last120), 18); // all three

  // dateBin flooring: two rows share a 5-minute bucket, one lands in the next.
  await db.insert(bin).values([
    { id: 1, at: "2026-01-01 10:01:00" },
    { id: 2, at: "2026-01-01 10:04:00" },
    { id: 3, at: "2026-01-01 10:06:00" },
  ]).execute();
  const bucket = dateBin({ minutes: 5 }, bin.columns.at);
  const groups = await db.select({ n: count() })
    .from(bin).groupBy(bucket).orderBy(asc(bucket)).execute();
  assertEquals(groups.map((g) => Number(g.n)), [2, 1]);
});

pgTest("pg: filter aggregate + dateTrunc bucketing", async (db) => {
  await db.execute(raw("drop table if exists it_agg cascade"));
  const agg = defineTable("it_agg", {
    id: columns.integer().primaryKey(),
    kind: columns.text().notNull(),
    score: columns.integer().notNull(),
    at: columns.timestamp({ mode: "string" }),
  });
  for (
    const stmt of generatePostgresUpStatements(
      createSchemaSnapshot({ dialect: "postgres", tables: [agg] }),
    ).statements
  ) await db.execute(stmt);

  await db.insert(agg).values([
    { id: 1, kind: "a", score: 10, at: "2026-01-01 10:15:00" },
    { id: 2, kind: "a", score: 20, at: "2026-01-01 10:45:00" },
    { id: 3, kind: "b", score: 5, at: "2026-01-01 11:30:00" },
    { id: 4, kind: "b", score: 7, at: "2026-01-01 11:45:00" },
  ]).execute();

  // FILTER aggregate: a conditional sum next to the unconditional total.
  const [totals] = await db.select({
    aSum: filter(sum(agg.columns.score), eq(agg.columns.kind, "a")),
    total: sum(agg.columns.score),
  }).from(agg).execute();
  assertEquals(Number(totals.aSum), 30);
  assertEquals(Number(totals.total), 42);

  // dateTrunc bucketing: two hour buckets, each summing its own rows.
  const bucket = dateTrunc("hour", agg.columns.at);
  const rows = await db.select({ n: count(), s: sum(agg.columns.score) })
    .from(agg).groupBy(bucket).orderBy(asc(bucket)).execute();
  assertEquals(rows.map((r) => Number(r.n)), [2, 2]);
  assertEquals(rows.map((r) => Number(r.s)), [30, 12]);
});

pgTest("pg: schema objects (functions/triggers/views)", async (db) => {
  await db.execute(raw("drop view if exists it_so_view cascade"));
  await db.execute(raw("drop table if exists it_so cascade"));
  await db.execute(raw("drop function if exists it_so_stamp() cascade"));

  const it_so = defineTable("it_so", {
    id: columns.integer().primaryKey(),
    label: columns.text().notNull(),
    stamped: columns.text(),
  });

  const snapshot = createSchemaSnapshot({
    dialect: "postgres",
    tables: [it_so],
    schemaObjects: [
      {
        name: "it_so_stamp",
        kind: "function",
        dialect: "postgres",
        up: "CREATE FUNCTION it_so_stamp() RETURNS trigger AS $$ BEGIN " +
          "NEW.stamped := 'auto'; RETURN NEW; END; $$ LANGUAGE plpgsql;",
        down: "DROP FUNCTION it_so_stamp() CASCADE;",
      },
      {
        name: "it_so_trg",
        kind: "trigger",
        dialect: "postgres",
        up: "CREATE TRIGGER it_so_trg BEFORE INSERT ON it_so " +
          "FOR EACH ROW EXECUTE FUNCTION it_so_stamp();",
        down: "DROP TRIGGER it_so_trg ON it_so;",
      },
      // Dialect-agnostic: emitted for Postgres and the SQLite family alike.
      {
        name: "it_so_view",
        kind: "view",
        up: "CREATE VIEW it_so_view AS SELECT id, label FROM it_so;",
        down: "DROP VIEW it_so_view;",
      },
    ],
  });

  const { statements, destructive } = generatePostgresUpStatements(snapshot);
  assertEquals(destructive.length, 0);
  // CREATE TABLE renders first; the stored objects trail it in declared order.
  assert(statements[0].startsWith('CREATE TABLE "it_so"'));
  for (const statement of statements) await db.execute(statement);

  // The BEFORE INSERT trigger ran: the function overwrote `stamped`.
  await db.insert(it_so).values({ id: 1, label: "x", stamped: null }).execute();
  const [row] = await db.select().from(it_so).execute();
  assertEquals(row.stamped, "auto");

  // The dialect-agnostic view resolves against the table.
  const view = await db.query<{ count: number }>(
    sql`select count(*)::int as count from it_so_view`,
  );
  assertEquals(Number(view.rows[0].count), 1);

  // Down: the matching drop statements (reverse declared order) remove the
  // stored objects — dependents (view, trigger) before the function.
  const downs = schemaObjectDropStatements(snapshot, "postgres");
  assertEquals(downs.length, 3);
  for (const statement of downs) await db.execute(statement);
  const left = await db.query<{ fn: number; vw: number }>(
    sql`select
          (select count(*)::int from pg_proc where proname = ${"it_so_stamp"}) as fn,
          (select count(*)::int from pg_views where viewname = ${"it_so_view"}) as vw`,
  );
  assertEquals(Number(left.rows[0].fn), 0);
  assertEquals(Number(left.rows[0].vw), 0);
});

pgTest("pg: teardown", async (db) => {
  await db.execute(
    raw(
      "drop view if exists it_so_view cascade",
    ),
  );
  await db.execute(
    raw(
      "drop table if exists it_all_types, it_posts, it_users, it_orgs, it_bin, it_widget, it_history, it_accounts, it_legacy, it_feed, it_temporal_values, it_expr, it_batch, it_rich_idx, it_floats, it_counters, it_dmcte, it_so, it_agg, it_rawmap, it_dm, it_dmbin, it_mj, it_mj_arch cascade",
    ),
  );
  await db.execute(
    raw(
      "drop function if exists it_add(integer, integer), it_pair(integer), it_echo_uuid(uuid), it_nums(), it_so_stamp() cascade",
    ),
  );
  await temporalDbHandle?.close();
  temporalDbHandle = undefined;
  await db.close();
  dbHandle = undefined;
});
