/**
 * libSQL / Turso feature/compatibility suite for `@sisal/libsql`.
 *
 * libSQL is a SQLite fork. This suite runs against a **local** libSQL file
 * (`file:`) via `npm:@libsql/client` and exercises every adapter feature. Point
 * it at a real Turso database by exporting `TURSO_DATABASE_URL` (+
 * `TURSO_AUTH_TOKEN`); otherwise it uses a temp file. The suite is gated on
 * `SISAL_LIBSQL_IT=1` so it stays out of the ordinary `deno task test`:
 *
 *   SISAL_LIBSQL_IT=1 deno test -A integration/libsql_features_test.ts
 *
 * Each `Deno.test` name maps to a row in docs/libsql-compatibility.md.
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
  raw,
  sql,
  sum,
} from "@sisal/orm";
import { defineSqlMigration } from "@sisal/migrate";
import {
  connect,
  createLibsqlMigrator,
  type LibsqlDatabase,
} from "@sisal/libsql";
import { generateLibsqlUpStatements } from "@sisal/libsql/ddl";

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

const RUN = env("SISAL_LIBSQL_IT") === "1";
const REMOTE_URL = env("TURSO_DATABASE_URL");
const AUTH_TOKEN = env("TURSO_AUTH_TOKEN");

let dbUrl: string | undefined;
let dbHandle: LibsqlDatabase | undefined;
async function db(): Promise<LibsqlDatabase> {
  if (dbHandle === undefined) {
    dbUrl = REMOTE_URL ?? `file:${await Deno.makeTempFile({ suffix: ".db" })}`;
    dbHandle = await connect({
      url: dbUrl,
      ...(AUTH_TOKEN === undefined ? {} : { authToken: AUTH_TOKEN }),
    });
  }
  return dbHandle;
}

let temporalDbHandle: LibsqlDatabase | undefined;
async function temporalDb(): Promise<LibsqlDatabase> {
  if (temporalDbHandle === undefined) {
    await db();
    temporalDbHandle = await connect({
      url: dbUrl!,
      ...(AUTH_TOKEN === undefined ? {} : { authToken: AUTH_TOKEN }),
      temporal: { parse: true },
    });
  }
  return temporalDbHandle;
}

function libsqlTest(
  name: string,
  fn: (db: LibsqlDatabase) => Promise<void> | void,
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
  updatedAt: columns.integer().$onUpdate(() => 1700000000),
});

const docs = defineTable("it_docs", {
  id: columns.integer().primaryKey(),
  data: columns.jsonb<{ note: string }>(),
  tags: columns.text().array(),
});

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
  c_time: columns.time(),
  c_ts: columns.timestamp(),
  c_tstz: columns.timestamp({ withTimezone: true }),
  c_uuid: columns.uuid(),
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

function assertTemporalRow(row: Record<string, unknown>): void {
  assertInstanceOf(row.plain_date, Temporal.PlainDate);
  assertEquals(row.plain_date.toString(), "2026-06-28");

  assertInstanceOf(row.plain_time, Temporal.PlainTime);
  assertTimePrefix(row.plain_time.toString(), "12:34:56.123");

  assertInstanceOf(row.plain_timestamp, Temporal.PlainDateTime);
  assert(
    row.plain_timestamp.toString().startsWith("2026-06-28T12:34:56.123"),
    row.plain_timestamp.toString(),
  );

  assertInstanceOf(row.instant_timestamp, Temporal.Instant);
  assert(
    row.instant_timestamp.toString().startsWith("2026-06-28T12:34:56.123"),
    row.instant_timestamp.toString(),
  );

  assertString(row.date_text);
  assertEquals(row.date_text, "2026-06-28");
  assertTimePrefix(row.time_text, "12:34:56.123");

  assertString(row.timestamp_text);
  assert(
    row.timestamp_text.startsWith("2026-06-28T12:34:56.123") ||
      row.timestamp_text.startsWith("2026-06-28 12:34:56.123"),
    row.timestamp_text,
  );

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

// ---------------------------------------------------------------------------

libsqlTest("libsql: connect + raw parameterized query", async (db) => {
  const result = await db.query<{ one: number; who: string }>(
    sql`select 1 as one, ${"sisal"} as who`,
  );
  assertEquals(Number(result.rows[0].one), 1);
  assertEquals(result.rows[0].who, "sisal");
});

libsqlTest("libsql: generated DDL applies (affinity mapping)", async (db) => {
  for (
    const table of [
      "it_all_types",
      "it_docs",
      "it_posts",
      "it_users",
      "it_orgs",
    ]
  ) {
    // table is a trusted literal from the loop above, never user input.
    // deno-lint-ignore sisal/no-raw-interpolation
    await db.execute(raw(`drop table if exists ${table}`));
  }
  const snapshot = createSchemaSnapshot({
    dialect: "sqlite",
    tables: [orgs, users, posts, docs, allTypes],
  });
  const { statements, destructive } = generateLibsqlUpStatements(snapshot);
  assertEquals(destructive.length, 0);
  for (const statement of statements) {
    await db.execute(statement);
  }
  const cols = await db.query<{ n: number }>(
    sql`select count(*) as n from pragma_table_info(${"it_all_types"})`,
  );
  assertEquals(Number(cols.rows[0].n), 19);
});

libsqlTest("libsql: insert + returning", async (db) => {
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
  assertEquals(Number(inserted.rows[0].id), 1);
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

libsqlTest("libsql: Temporal date/time modes", async (db) => {
  const parsed = await temporalDb();

  await db.execute(raw("drop table if exists it_temporal_values"));

  const snapshot = createSchemaSnapshot({
    dialect: "sqlite",
    tables: [temporalValues],
  });
  const { statements, destructive } = generateLibsqlUpStatements(snapshot);
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

libsqlTest(
  "libsql: filter operators (eq/ne/gt/lt/in/null/and/or/not)",
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

libsqlTest("libsql: like / notLike", async (db) => {
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

libsqlTest(
  "libsql: ilike works (degrades to case-insensitive LIKE)",
  async (db) => {
    const rows = await db.select().from(users)
      .where(ilike(users.columns.email, "A%")).execute();
    assertEquals(rows.length, 1); // matches lowercase "a@example.com"
  },
);

libsqlTest("libsql: bytea/BLOB binary round-trip", async (db) => {
  const bin = defineTable("it_bin", {
    id: columns.integer().primaryKey(),
    data: columns.bytea(),
  });
  await db.execute(
    generateLibsqlUpStatements(
      createSchemaSnapshot({ dialect: "sqlite", tables: [bin] }),
    ).statements[0],
  );
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  await db.insert(bin).values({ id: 1, data: bytes }).execute();
  const rows = await db.select({ data: bin.columns.data }).from(bin)
    .where(eq(bin.columns.id, 1)).execute();
  // @libsql/client returns BLOBs as ArrayBuffer (SQLite/PG return Uint8Array).
  const raw = rows[0].data as unknown as ArrayBuffer | Uint8Array;
  const out = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  assertEquals(Array.from(out), [0, 1, 2, 250, 255]);
});

libsqlTest("libsql: orderBy asc/desc + limit + offset", async (db) => {
  const rows = await db.select().from(users)
    .where(isNotNull(users.columns.age))
    .orderBy(desc(users.columns.age), asc(users.columns.email))
    .limit(2).offset(0).execute();
  assertEquals(rows.map((r) => Number(r.id)), [3, 1]);
});

libsqlTest("libsql: distinct", async (db) => {
  const rows = await db.select({ orgId: users.columns.orgId }).from(users)
    .distinct().execute();
  assertEquals(rows.length, 3);
});

libsqlTest("libsql: inner / left joins", async (db) => {
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

libsqlTest("libsql: right / full joins", async (db) => {
  const projection = { uid: users.columns.id, oid: orgs.columns.id };
  const right = await db.select(projection).from(users)
    .rightJoin(orgs, eq(orgs.columns.id, users.columns.orgId)).execute();
  assert(right.length >= 3);
  const full = await db.select(projection).from(users)
    .fullJoin(orgs, eq(orgs.columns.id, users.columns.orgId)).execute();
  assert(full.length >= 4);
});

libsqlTest("libsql: aggregates + groupBy + having", async (db) => {
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

libsqlTest("libsql: $count + countDistinct", async (db) => {
  assertEquals(await db.$count(users), 4);
  assertEquals(await db.$count(users, isNotNull(users.columns.age)), 3);

  const distinct = await db
    .select({ orgs: countDistinct(users.columns.orgId) })
    .from(users).execute();
  assertEquals(Number(distinct[0].orgs), 2); // org ids {1, 2}; null excluded
});

libsqlTest("libsql: exists / notExists (correlated subquery)", async (db) => {
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

libsqlTest(
  "libsql: subqueries (derived table, scalar, inArray)",
  async (db) => {
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
    assertEquals(acme.length, 2);
  },
);

libsqlTest("libsql: update + returning + $onUpdate", async (db) => {
  await db.insert(posts).values({ id: 1, title: "first", updatedAt: null })
    .execute();
  const updated = await db.update(posts).set({ title: "renamed" })
    .where(eq(posts.columns.id, 1)).returning().execute();
  assertEquals(updated.rows[0].title, "renamed");
  assertEquals(Number(updated.rows[0].updatedAt), 1700000000);
});

libsqlTest("libsql: delete + returning", async (db) => {
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
  assertEquals(Number(removed.rows[0].id), 99);
});

libsqlTest(
  "libsql: upsert (onConflictDoNothing / onConflictDoUpdate)",
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

libsqlTest("libsql: transaction commit and rollback", async (db) => {
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

libsqlTest("libsql: boolean stored as INTEGER 0/1", async (db) => {
  const rows = await db.select({ active: users.columns.active }).from(users)
    .where(eq(users.columns.id, 1)).execute();
  assertEquals(Number(rows[0].active), 1);
});

libsqlTest("libsql: JSON object round-trips as text", async (db) => {
  await db.insert(docs).values({ id: 1, data: { note: "x" }, tags: null })
    .execute();
  const rows = await db.query<{ data: string }>(
    sql`select data from it_docs where id = ${1}`,
  );
  assertEquals(JSON.parse(rows.rows[0].data).note, "x");
});

libsqlTest("libsql: text[] array round-trips as JSON text", async (db) => {
  await db.insert(docs).values({ id: 2, data: null, tags: ["a", "b"] })
    .execute();
  const rows = await db.query<{ tags: string }>(
    sql`select tags from it_docs where id = ${2}`,
  );
  assertEquals(JSON.parse(rows.rows[0].tags), ["a", "b"]);
});

libsqlTest(
  "libsql: sql expressions in SET / VALUES / onConflict",
  async (db) => {
    const expr = defineTable("it_expr", {
      id: columns.integer().primaryKey(),
      label: columns.text().notNull(),
      score: columns.integer().notNull(),
      upvotes: columns.integer().notNull(),
      downvotes: columns.integer().notNull(),
    });
    await db.execute(raw("drop table if exists it_expr"));
    await db.execute(
      generateLibsqlUpStatements(
        createSchemaSnapshot({ dialect: "sqlite", tables: [expr] }),
      ).statements[0],
    );
    const get = async () =>
      (await db.select().from(expr).where(eq(expr.columns.id, 1)).execute())[0];

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

    await db.update(expr).set({
      score: sql`${expr.columns.upvotes} - ${expr.columns.downvotes}`,
    }).where(eq(expr.columns.id, 1)).execute();
    assertEquals(Number((await get()).score), 2);

    await db.update(expr).set({ label: sql`upper(${expr.columns.label})` })
      .where(eq(expr.columns.id, 1)).execute();
    assertEquals((await get()).label, "HI");

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
  },
);

libsqlTest(
  "libsql: batch runs statements atomically (commit + rollback)",
  async (db) => {
    const batchT = defineTable("it_batch", {
      id: columns.integer().primaryKey(),
      score: columns.integer().notNull(),
    });
    await db.execute(raw("drop table if exists it_batch"));
    await db.execute(
      generateLibsqlUpStatements(
        createSchemaSnapshot({ dialect: "sqlite", tables: [batchT] }),
      ).statements[0],
    );
    const all = async () => (await db.select().from(batchT).orderBy(
      asc(batchT.columns.id),
    )
      .execute());

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

    // A failing statement (duplicate PK) rolls the whole batch back.
    await assertRejects(() =>
      db.batch([
        db.insert(batchT).values({ id: 3, score: 30 }),
        db.insert(batchT).values({ id: 1, score: 99 }),
      ])
    );
    assertEquals((await all()).map((r) => Number(r.id)), [1, 2]);
  },
);

libsqlTest("libsql: migrator applies, plans, and is idempotent", async () => {
  const migrator = await createLibsqlMigrator({
    url: dbUrl!,
    ...(AUTH_TOKEN === undefined ? {} : { authToken: AUTH_TOKEN }),
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

libsqlTest("libsql: teardown", async (db) => {
  await temporalDbHandle?.close();
  temporalDbHandle = undefined;
  await db.close();
  dbHandle = undefined;
  if (dbUrl !== undefined && dbUrl.startsWith("file:")) {
    try {
      await Deno.remove(dbUrl.slice("file:".length));
    } catch { /* ignore */ }
  }
});
