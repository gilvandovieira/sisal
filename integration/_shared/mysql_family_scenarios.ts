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
  type Database,
  dateBin,
  dateSub,
  dateTrunc,
  defineAtomicOperation,
  defineTable,
  desc,
  eq,
  excluded,
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
  notInArray,
  notLike,
  now,
  or,
  OrmError,
  placeholder,
  primaryKey,
  raw,
  type SisalSchemaSnapshot,
  sql,
  sum,
  uniqueIndex,
} from "@sisal/orm";
import { defineSqlMigration } from "@sisal/migrate";
import { insertReturning } from "@sisal/mysql";

import type {
  IntegrationMigrator,
  IntegrationMigratorOptions,
  IntegrationScenario,
  IntegrationTarget,
  IntegrationUpStatements,
} from "./target.ts";
import { scenarioId, stripAdapterPrefix } from "./target.ts";

type ScenarioFn = (db: Database) => Promise<void> | void;

let activeTarget: IntegrationTarget | undefined;

function currentTarget(): IntegrationTarget {
  if (activeTarget === undefined) {
    throw new Error("No active integration target");
  }
  return activeTarget;
}

function scenarioCollector(scenarios: IntegrationScenario[]) {
  return (name: string, fn: ScenarioFn): void => {
    scenarios.push({
      id: scenarioId(name),
      name: stripAdapterPrefix(name),
      run: async (target) => {
        activeTarget = target;
        try {
          await fn(await target.db());
        } finally {
          activeTarget = undefined;
        }
      },
    });
  };
}

async function temporalDb(): Promise<Database> {
  return await currentTarget().temporalDb();
}

function generateMysqlUp(
  snapshot: SisalSchemaSnapshot,
): IntegrationUpStatements {
  return currentTarget().generateUp(snapshot);
}

async function createTargetMigrator(
  options: IntegrationMigratorOptions = {},
): Promise<IntegrationMigrator> {
  return await currentTarget().migrator(options);
}

async function applyTables(
  db: Database,
  tables: Parameters<typeof createSchemaSnapshot>[0]["tables"],
): Promise<void> {
  const { statements, destructive } = generateMysqlUp(
    createSchemaSnapshot({ dialect: "mysql", tables }),
  );
  assertEquals(destructive.length, 0);
  for (const statement of statements) {
    await db.execute(statement);
  }
}

async function dropTables(db: Database, names: readonly string[]) {
  for (const name of names) {
    // name is a trusted literal from the callers below, never user input.
    // deno-lint-ignore sisal/no-raw-interpolation
    await db.execute(raw(`drop table if exists ${name}`));
  }
}

function assertTypedGuard(error: unknown, needle: string): void {
  assertInstanceOf(error, OrmError);
  assertEquals(error.code, "ORM_DIALECT_UNSUPPORTED");
  assert(error.message.includes(needle), error.message);
}

// ---- schema (scalar-only seed; arrays/JSON are probed separately) ----------

const orgs = defineTable("it_orgs", {
  id: columns.integer().primaryKey(),
  name: columns.varchar(100).notNull(),
});

const users = defineTable("it_users", {
  id: columns.integer().primaryKey(),
  email: columns.varchar(320).notNull(),
  name: columns.varchar(100),
  age: columns.integer(),
  active: columns.boolean(),
  score: columns.numeric(10, 2),
  orgId: columns.integer(),
});

const posts = defineTable("it_posts", {
  id: columns.integer().primaryKey(),
  title: columns.varchar(200).notNull(),
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

export function mysqlFamilyScenarios(): IntegrationScenario[] {
  const scenarios: IntegrationScenario[] = [];
  const mysqlTest = scenarioCollector(scenarios);

  mysqlTest("mysql: connect + raw parameterized query", async (db) => {
    const result = await db.query<{ one: number; who: string }>(
      sql`select 1 as one, ${"sisal"} as who`,
    );
    assertEquals(Number(result.rows[0].one), 1);
    assertEquals(result.rows[0].who, "sisal");
  });

  mysqlTest("mysql: generated DDL applies (type mapping)", async (db) => {
    await dropTables(db, [
      "it_all_types",
      "it_docs",
      "it_posts",
      "it_users",
      "it_orgs",
    ]);
    await applyTables(db, [orgs, users, posts, docs, allTypes]);
    const cols = await db.query<{ n: number }>(
      sql`select count(*) as n from information_schema.columns
        where table_schema = database() and table_name = ${"it_all_types"}`,
    );
    assertEquals(Number(cols.rows[0].n), 19);
  });

  mysqlTest(
    "mysql: insert + returning strategy (native or fetch-by-key)",
    async (db) => {
      await db.insert(orgs).values([
        { id: 1, name: "Acme" },
        { id: 2, name: "Globex" },
      ]).execute();

      // insertReturning picks the best strategy per identity: real
      // INSERT … RETURNING on MariaDB (auto-detected), the B7 transactional
      // fetch-by-key fallback on MySQL proper. Same rows either way.
      const inserted = await insertReturning(db, users, {
        id: 1,
        email: "a@example.com",
        name: "Alice",
        age: 30,
        active: true,
        score: "10.50",
        orgId: 1,
      });
      assertEquals(Number(inserted[0].id), 1);
      assertEquals(inserted[0].email, "a@example.com");

      // The raw builder path pins the identity split: `.returning()` renders
      // on a lit MariaDB identity and throws typed on MySQL proper.
      if (currentTarget().capabilities.returning) {
        const direct = await db.insert(users).values({
          id: 2,
          email: "b@example.com",
          name: "Bob",
          age: 17,
          active: false,
          score: "5.00",
          orgId: 1,
        }).returning().execute();
        assertEquals(Number(direct.rows[0].id), 2);
      } else {
        const error = await assertRejects(() =>
          db.insert(users).values({
            id: 2,
            email: "x@example.com",
            name: null,
            age: null,
            active: null,
            score: null,
            orgId: null,
          }).returning().execute()
        );
        assertTypedGuard(error, "INSERT … RETURNING");
        await db.insert(users).values({
          id: 2,
          email: "b@example.com",
          name: "Bob",
          age: 17,
          active: false,
          score: "5.00",
          orgId: 1,
        }).execute();
      }

      await db.insert(users).values([
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
    },
  );

  mysqlTest("mysql: Temporal date/time modes", async (db) => {
    const parsed = await temporalDb();

    await dropTables(db, ["it_temporal_values"]);
    await applyTables(db, [temporalValues]);

    await parsed.insert(temporalValues).values({
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
      // mode:"string" hands the literal to the engine verbatim — a MySQL
      // user writes a MySQL-valid one (no `Z`; the naive-UTC convention).
      instant_text: "2026-06-28 12:34:56.123456",
      legacy_date: null,
      legacy_timestamp: null,
      legacy_instant: null,
    }).execute();
    const [round] = await parsed.select().from(temporalValues)
      .where(eq(temporalValues.columns.id, 1)).execute();
    assertTemporalRow(round as Record<string, unknown>);

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

    const rawResult = await parsed.query<{ plain_date: unknown }>(
      sql`select ${"2026-06-28"} as plain_date`,
    );
    assertEquals(rawResult.rows[0].plain_date, "2026-06-28");
  });

  mysqlTest(
    "mysql: filter operators (eq/ne/gt/lt/in/null/and/or/not)",
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
        await len(
          and(eq(users.columns.active, true), gt(users.columns.age, 20)),
        ),
        2,
      );
      assertEquals(
        await len(or(eq(users.columns.id, 1), eq(users.columns.id, 2))),
        2,
      );
      assertEquals(await len(not(eq(users.columns.id, 1))), 3);
    },
  );

  mysqlTest("mysql: like / notLike", async (db) => {
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

  mysqlTest(
    "mysql: ilike works (LIKE is collation-case-insensitive)",
    async (db) => {
      const rows = await db.select().from(users)
        .where(ilike(users.columns.email, "A%")).execute();
      assertEquals(rows.length, 1); // matches lowercase "a@example.com"
    },
  );

  mysqlTest("mysql: bytea/BLOB binary round-trip", async (db) => {
    const bin = defineTable("it_bin", {
      id: columns.integer().primaryKey(),
      data: columns.bytea(),
    });
    await dropTables(db, ["it_bin"]);
    await applyTables(db, [bin]);
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    await db.insert(bin).values({ id: 1, data: bytes }).execute();
    const rows = await db.select({ data: bin.columns.data }).from(bin)
      .where(eq(bin.columns.id, 1)).execute();
    const out = rows[0].data as Uint8Array;
    assertInstanceOf(out, Uint8Array);
    assertEquals(Array.from(out), [0, 1, 2, 250, 255]);
  });

  mysqlTest("mysql: float (real/double) reads back as number", async (db) => {
    const floats = defineTable("it_floats", {
      id: columns.integer().primaryKey(),
      f8: columns.doublePrecision(),
    });
    await dropTables(db, ["it_floats"]);
    await applyTables(db, [floats]);
    await db.insert(floats).values({ id: 1, f8: 306.25 }).execute();
    const [row] = await db.select().from(floats)
      .where(eq(floats.columns.id, 1)).execute();
    assertEquals(typeof row.f8, "number");
    assertEquals(Number(row.f8), 306.25);
  });

  mysqlTest("mysql: orderBy asc/desc + limit + offset", async (db) => {
    const rows = await db.select().from(users)
      .where(isNotNull(users.columns.age))
      .orderBy(desc(users.columns.age), asc(users.columns.email))
      .limit(2).offset(0).execute();
    assertEquals(rows.map((r) => Number(r.id)), [3, 1]);
  });

  mysqlTest("mysql: distinct", async (db) => {
    const rows = await db.select({ orgId: users.columns.orgId }).from(users)
      .distinct().execute();
    assertEquals(rows.length, 3);
  });

  mysqlTest("mysql: inner / left / right joins", async (db) => {
    const inner = await db.select({
      u: users.columns.email,
      o: orgs.columns.name,
    })
      .from(users).innerJoin(orgs, eq(orgs.columns.id, users.columns.orgId))
      .execute();
    assertEquals(inner.length, 3);
    const left = await db.select({
      uid: users.columns.id,
      oid: orgs.columns.id,
    })
      .from(users).leftJoin(orgs, eq(orgs.columns.id, users.columns.orgId))
      .execute();
    assertEquals(left.length, 4);
    const right = await db.select({
      uid: users.columns.id,
      oid: orgs.columns.id,
    })
      .from(users).rightJoin(orgs, eq(orgs.columns.id, users.columns.orgId))
      .execute();
    assert(right.length >= 3);
  });

  mysqlTest("mysql: FULL JOIN throws a typed guard", async (db) => {
    const error = await assertRejects(() =>
      db.select({ uid: users.columns.id, oid: orgs.columns.id }).from(users)
        .fullJoin(orgs, eq(orgs.columns.id, users.columns.orgId)).execute()
    );
    assertTypedGuard(error, "FULL JOIN");
  });

  mysqlTest("mysql: aggregates + groupBy + having", async (db) => {
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

  mysqlTest("mysql: $count + countDistinct", async (db) => {
    assertEquals(await db.$count(users), 4);
    assertEquals(await db.$count(users, isNotNull(users.columns.age)), 3);

    const distinct = await db
      .select({ orgs: countDistinct(users.columns.orgId) })
      .from(users).execute();
    assertEquals(Number(distinct[0].orgs), 2); // org ids {1, 2}; null excluded
  });

  mysqlTest("mysql: exists / notExists (correlated subquery)", async (db) => {
    const withUsers = db.select({ one: users.columns.id }).from(users)
      .where(eq(users.columns.orgId, orgs.columns.id));
    assertEquals(
      (await db.select().from(orgs).where(exists(withUsers)).execute()).length,
      2,
    );
    assertEquals(
      (await db.select().from(orgs).where(notExists(withUsers)).execute())
        .length,
      0,
    );
  });

  mysqlTest(
    "mysql: subqueries (derived table, scalar, inArray)",
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

  mysqlTest("mysql: for update row locking", async (db) => {
    await db.transaction(async (tx) => {
      const rows = await tx.select().from(users)
        .where(eq(users.columns.id, 1)).for("update").execute();
      assertEquals(rows.length, 1);
    });
  });

  mysqlTest("mysql: update + $onUpdate (verified by re-select)", async (db) => {
    await db.insert(posts).values({ id: 1, title: "first", updatedAt: null })
      .execute();
    await db.update(posts).set({ title: "renamed" })
      .where(eq(posts.columns.id, 1)).execute();
    const [row] = await db.select().from(posts)
      .where(eq(posts.columns.id, 1)).execute();
    assertEquals(row.title, "renamed");
    assertEquals(Number(row.updatedAt), 1700000000);

    // UPDATE … RETURNING is guarded on both variants: MySQL has none, and
    // MariaDB's floor is 13.0 (per-statement lighting, B1).
    const error = await assertRejects(() =>
      db.update(posts).set({ title: "again" })
        .where(eq(posts.columns.id, 1)).returning().execute()
    );
    assertTypedGuard(error, "UPDATE … RETURNING");
  });

  mysqlTest("mysql: delete (returning lights on MariaDB)", async (db) => {
    await db.insert(users).values({
      id: 99,
      email: "tmp@example.com",
      name: "Temp",
      age: 50,
      active: true,
      score: "1.00",
      orgId: 1,
    }).execute();

    if (currentTarget().capabilities.returning) {
      const removed = await db.delete(users).where(eq(users.columns.id, 99))
        .returning().execute();
      assertEquals(Number(removed.rows[0].id), 99);
    } else {
      const error = await assertRejects(() =>
        db.delete(users).where(eq(users.columns.id, 99)).returning().execute()
      );
      assertTypedGuard(error, "DELETE … RETURNING");
      await db.delete(users).where(eq(users.columns.id, 99)).execute();
    }
    assertEquals(
      (await db.select().from(users).where(eq(users.columns.id, 99))
        .execute()).length,
      0,
    );
  });

  mysqlTest(
    "mysql: upsert (ON DUPLICATE KEY UPDATE via onConflict)",
    async (db) => {
      await db.insert(orgs).values({ id: 1, name: "dup" })
        .onConflictDoNothing({ target: orgs.columns.id }).execute();
      assertEquals(
        (await db.select().from(orgs).where(eq(orgs.columns.id, 1)).execute())[
          0
        ]
          .name,
        "Acme",
      );
      await db.insert(orgs).values({ id: 1, name: "ignored" })
        .onConflictDoUpdate({
          target: orgs.columns.id,
          set: { name: "Acme v2" },
        })
        .execute();
      assertEquals(
        (await db.select().from(orgs).where(eq(orgs.columns.id, 1)).execute())[
          0
        ]
          .name,
        "Acme v2",
      );

      // The typed excluded() proposed-row reference (C2) renders MySQL
      // `values(col)` — portable across MySQL 8/9 and MariaDB.
      await db.insert(orgs).values({ id: 1, name: "Acme v3" })
        .onConflictDoUpdate({
          target: orgs.columns.id,
          set: { name: excluded(orgs.columns.name) },
        })
        .execute();
      assertEquals(
        (await db.select().from(orgs).where(eq(orgs.columns.id, 1)).execute())[
          0
        ]
          .name,
        "Acme v3",
      );
    },
  );

  mysqlTest("mysql: transaction commit and rollback", async (db) => {
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

  mysqlTest("mysql: boolean stored as TINYINT 0/1", async (db) => {
    const rows = await db.select({ active: users.columns.active }).from(users)
      .where(eq(users.columns.id, 1)).execute();
    assertEquals(Number(rows[0].active), 1);
  });

  mysqlTest("mysql: JSON object round-trips (parsed or text)", async (db) => {
    await db.insert(docs).values({ id: 1, data: { note: "x" }, tags: null })
      .execute();
    const rows = await db.query<{ data: unknown }>(
      sql`select data from it_docs where id = ${1}`,
    );
    const value = rows.rows[0].data;
    if (currentTarget().valueShape.json === "parsed") {
      assertEquals((value as { note: string }).note, "x");
    } else {
      assertString(value);
      assertEquals(JSON.parse(value).note, "x");
    }
  });

  mysqlTest("mysql: text[] array round-trips as JSON", async (db) => {
    await db.insert(docs).values({ id: 2, data: null, tags: ["a", "b"] })
      .execute();
    const rows = await db.query<{ tags: unknown }>(
      sql`select tags from it_docs where id = ${2}`,
    );
    const value = rows.rows[0].tags;
    if (currentTarget().valueShape.array === "jsonParsed") {
      assertEquals(value, ["a", "b"]);
    } else {
      assertString(value);
      assertEquals(JSON.parse(value), ["a", "b"]);
    }
  });

  mysqlTest(
    "mysql: column naming (snake_case default, .named, preserve)",
    async (db) => {
      const accounts = defineTable("it_accounts", {
        id: columns.integer().primaryKey(),
        fullName: columns.varchar(100),
        hotScore: columns.doublePrecision(),
        legacyTag: columns.varchar(20).named("legacy"),
      });
      const legacyTable = defineTable("it_legacy", {
        id: columns.integer().primaryKey(),
        keepThis: columns.varchar(20),
      }, { naming: "preserve" });

      await dropTables(db, ["it_accounts", "it_legacy"]);
      await applyTables(db, [accounts, legacyTable]);

      const names = async (table: string) =>
        (await db.query<{ name: string }>(
          sql`select column_name as name from information_schema.columns
            where table_schema = database() and table_name = ${table}
            order by ordinal_position`,
        )).rows.map((r) => r.name);

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

  mysqlTest("mysql: keyset pagination (expanded + row-value)", async (db) => {
    const feed = defineTable("it_feed", {
      id: columns.integer().primaryKey(),
      score: columns.integer().notNull(),
    });
    await dropTables(db, ["it_feed"]);
    await applyTables(db, [feed]);
    await db.insert(feed).values([
      { id: 1, score: 10 },
      { id: 2, score: 20 },
      { id: 3, score: 20 }, // tie with id 2 on score; id is the tiebreaker
      { id: 4, score: 5 },
      { id: 5, score: 15 },
    ]).execute();

    const pageAll = async (
      form: "expanded" | "row-value",
    ): Promise<number[]> => {
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
    // The v0.7 open question, answered live: MySQL row-value comparisons
    // work, so the row-value keyset form paginates identically.
    assertEquals(await pageAll("row-value"), [3, 2, 5, 1, 4]);
  });

  mysqlTest("mysql: prepared statement binds placeholders", async (db) => {
    const byId = db.select().from(users)
      .where(eq(users.columns.id, placeholder("id"))).prepare();
    assertEquals((await byId.execute({ id: 1 })).length, 1);
    assertEquals((await byId.execute({ id: 999 })).length, 0);
  });

  mysqlTest(
    "mysql: sql expressions in SET / VALUES / onConflict",
    async (db) => {
      const expr = defineTable("it_expr", {
        id: columns.integer().primaryKey(),
        label: columns.varchar(50).notNull(),
        score: columns.integer().notNull(),
        upvotes: columns.integer().notNull(),
        downvotes: columns.integer().notNull(),
      });
      await dropTables(db, ["it_expr"]);
      await applyTables(db, [expr]);
      const get = async () =>
        (await db.select().from(expr).where(eq(expr.columns.id, 1)).execute())[
          0
        ];

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

  mysqlTest(
    "mysql: batch runs statements atomically (commit + rollback)",
    async (db) => {
      const batchT = defineTable("it_batch", {
        id: columns.integer().primaryKey(),
        score: columns.integer().notNull(),
      });
      await dropTables(db, ["it_batch"]);
      await applyTables(db, [batchT]);
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

  mysqlTest(
    "mysql: rich indexes (DESC applies; partial/expression throw typed)",
    async (db) => {
      await dropTables(db, ["it_rich_idx"]);
      const descIdx = defineTable("it_rich_idx", {
        id: columns.integer().primaryKey(),
        hotScore: columns.integer(),
        createdAt: columns.timestamp(),
      }, (t) => [
        index("it_rich_hot").on(desc(t.hotScore), desc(t.createdAt)),
      ]);
      await applyTables(db, [descIdx]);
      const defs = await db.query<{ name: string; coll: string }>(
        sql`select index_name as name, collation as coll
          from information_schema.statistics
          where table_schema = database() and table_name = ${"it_rich_idx"}
            and index_name = ${"it_rich_hot"}
          order by seq_in_index`,
      );
      // Collation "D" = descending index key, live-applied.
      assertEquals(defs.rows.map((r) => r.coll), ["D", "D"]);

      // Partial (WHERE) and expression indexes fail closed at generation
      // time (B5): partial is unsupported on both engines; functional
      // indexes are MySQL-only (MariaDB rejects them).
      const partial = defineTable("it_rich_partial", {
        id: columns.integer().primaryKey(),
        status: columns.varchar(20),
      }, (t) => [
        index("it_partial").where(sql`${t.status} = 'x'`).on(t.status),
      ]);
      let error = await assertRejects(async () => {
        await applyTables(db, [partial]);
      });
      assertTypedGuard(error, "partial indexes");

      const expression = defineTable("it_rich_expr", {
        id: columns.integer().primaryKey(),
        email: columns.varchar(100),
      }, (t) => [uniqueIndex("it_lower_email").on(sql`lower(${t.email})`)]);
      error = await assertRejects(async () => {
        await applyTables(db, [expression]);
      });
      assertTypedGuard(error, "functional indexes");
    },
  );

  mysqlTest("mysql: atomic op single-round-trip dispatch", async (db) => {
    await dropTables(db, ["it_srt"]);
    const t = defineTable("it_srt", {
      id: columns.integer().primaryKey(),
      n: columns.integer().notNull(),
    });
    await applyTables(db, [t]);
    await db.insert(t).values({ id: 1, n: 0 }).execute();

    const bump = defineAtomicOperation<{ id: number }, number>("bump_srt", {
      body: async (tx, { id }) => {
        const [row] = await tx.select({ n: t.columns.n }).from(t)
          .where(eq(t.columns.id, id)).execute();
        const next = Number(row.n) + 1;
        await tx.update(t).set({ n: next }).where(eq(t.columns.id, id))
          .execute();
        return next;
      },
      singleStatement: async (database, { id }) => {
        const u = database.$with("u").as(
          database.update(t).set({ n: sql`${t.columns.n} + 1` })
            .where(eq(t.columns.id, id)).returning({ n: t.columns.n }),
        );
        const [row] = await database.with(u).select({ n: u.n }).from(u)
          .execute();
        return Number(row.n);
      },
    });

    assertEquals(await bump.run(db, { id: 1 }), 1);
    assertEquals(await bump.run(db, { id: 1 }), 2);
    const [final] = await db.select().from(t).where(eq(t.columns.id, 1))
      .execute();
    assertEquals(Number(final.n), 2);
  });

  mysqlTest("mysql: atomic operation (transaction script)", async (db) => {
    const counters = defineTable("it_counters", {
      id: columns.integer().primaryKey(),
      n: columns.integer().notNull(),
    });
    await dropTables(db, ["it_counters"]);
    await applyTables(db, [counters]);

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

  mysqlTest(
    "mysql: migrator applies, plans, and is idempotent (GET_LOCK)",
    async (db) => {
      await dropTables(db, ["it_widget", "it_history"]);
      const migrator = await createTargetMigrator({
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
    },
  );

  mysqlTest("mysql: typed raw-query mapping (.as)", async (db) => {
    await dropTables(db, ["it_rawmap"]);
    const t = defineTable("it_rawmap", {
      id: columns.integer().primaryKey(),
      hotScore: columns.integer(),
      createdAt: columns.timestamp({ mode: "string" }),
    });
    await applyTables(db, [t]);

    await db.insert(t).values({
      id: 1,
      hotScore: 42,
      createdAt: "2026-01-01 09:00:00",
    }).execute();

    const rawResult = await db.query(raw("select * from it_rawmap"));
    assert("hot_score" in (rawResult.rows[0] as Record<string, unknown>));

    const rows = await db.query(raw("select * from it_rawmap")).as(t);
    assertEquals(rows.length, 1);
    assertEquals(Number(rows[0].id), 1);
    assertEquals(Number(rows[0].hotScore), 42);

    const viaMap = await db.query(raw("select * from it_rawmap"))
      .as<{ id: number; hot: number }>({ id: {}, hot: { name: "hot_score" } });
    assertEquals(Number(viaMap[0].hot), 42);
  });

  mysqlTest(
    "mysql: date math window (now / dateSub / dateBin)",
    async (db) => {
      await dropTables(db, ["it_dm", "it_dmbin"]);
      const win = defineTable("it_dm", {
        id: columns.integer().primaryKey(),
        score: columns.integer().notNull(),
        at: columns.timestamp({ mode: "string" }),
      });
      const bin = defineTable("it_dmbin", {
        id: columns.integer().primaryKey(),
        at: columns.timestamp({ mode: "string" }),
      });
      await applyTables(db, [win, bin]);

      await db.insert(win).values([
        { id: 1, score: 10, at: dateSub(now(), { minutes: 2 }) },
        { id: 2, score: 5, at: dateSub(now(), { minutes: 30 }) },
        { id: 3, score: 3, at: dateSub(now(), { minutes: 90 }) },
      ]).execute();

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
      assertEquals(Number(w.last15), 10);
      assertEquals(Number(w.last60), 15);
      assertEquals(Number(w.last120), 18);

      await db.insert(bin).values([
        { id: 1, at: "2026-01-01 10:01:00" },
        { id: 2, at: "2026-01-01 10:04:00" },
        { id: 3, at: "2026-01-01 10:06:00" },
      ]).execute();
      const bucket = dateBin({ minutes: 5 }, bin.columns.at);
      const groups = await db.select({ n: count() })
        .from(bin).groupBy(bucket).orderBy(asc(bucket)).execute();
      assertEquals(groups.map((g) => Number(g.n)), [2, 1]);
    },
  );

  mysqlTest(
    "mysql: mutation joins (UPDATE FROM + DELETE USING + INSERT SELECT)",
    async (db) => {
      await dropTables(db, ["it_mj", "it_mj_arch"]);
      const mj = defineTable("it_mj", {
        id: columns.integer().primaryKey(),
        n: columns.integer().notNull(),
      });
      const arch = defineTable("it_mj_arch", {
        id: columns.integer().primaryKey(),
        n: columns.integer().notNull(),
      });
      await applyTables(db, [mj, arch]);

      await db.insert(mj).values([
        { id: 1, n: 10 },
        { id: 2, n: 20 },
        { id: 3, n: 30 },
      ]).execute();

      const big = db.$with("big").as(
        db.select({ id: mj.columns.id }).from(mj).where(gte(mj.columns.n, 20)),
      );
      await db.with(big).update(mj).set({ n: 0 })
        .from(big).where(eq(mj.columns.id, big.id)).execute();

      const zeroed = await db.select().from(mj).where(eq(mj.columns.n, 0))
        .orderBy(asc(mj.columns.id)).execute();
      assertEquals(zeroed.map((row) => row.id), [2, 3]);

      // INSERT … SELECT works.
      await db.insert(arch).select(
        db.select({ id: mj.columns.id, n: mj.columns.n }).from(mj)
          .where(eq(mj.columns.n, 0)),
      ).execute();
      assertEquals((await db.select().from(arch).execute()).length, 2);

      const small = db.$with("small").as(
        db.select({ id: mj.columns.id }).from(mj).where(eq(mj.columns.n, 10)),
      );
      await db.with(small).delete(mj).using(small)
        .where(eq(mj.columns.id, small.id)).execute();

      const remaining = await db.select({ id: mj.columns.id }).from(mj)
        .orderBy(asc(mj.columns.id)).execute();
      assertEquals(remaining.map((row) => row.id), [2, 3]);
    },
  );

  mysqlTest("mysql: filter aggregate + dateTrunc bucketing", async (db) => {
    await dropTables(db, ["it_agg"]);
    const agg = defineTable("it_agg", {
      id: columns.integer().primaryKey(),
      kind: columns.varchar(20).notNull(),
      score: columns.integer().notNull(),
      at: columns.timestamp({ mode: "string" }),
    });
    await applyTables(db, [agg]);

    await db.insert(agg).values([
      { id: 1, kind: "a", score: 10, at: "2026-01-01 10:15:00" },
      { id: 2, kind: "a", score: 20, at: "2026-01-01 10:45:00" },
      { id: 3, kind: "b", score: 5, at: "2026-01-01 11:30:00" },
      { id: 4, kind: "b", score: 7, at: "2026-01-01 11:45:00" },
    ]).execute();

    // filter() renders the CASE WHEN portable form under mysql (B2).
    const [totals] = await db.select({
      aSum: filter(sum(agg.columns.score), eq(agg.columns.kind, "a")),
      total: sum(agg.columns.score),
    }).from(agg).execute();
    assertEquals(Number(totals.aSum), 30);
    assertEquals(Number(totals.total), 42);

    // dateTrunc bucketing via DATE_FORMAT: two hour buckets.
    const bucket = dateTrunc("hour", agg.columns.at);
    const rows = await db.select({ n: count(), s: sum(agg.columns.score) })
      .from(agg).groupBy(bucket).orderBy(asc(bucket)).execute();
    assertEquals(rows.map((r) => Number(r.n)), [2, 2]);
    assertEquals(rows.map((r) => Number(r.s)), [30, 12]);
  });

  mysqlTest(
    "mysql: ETL rollup (insert-from-select + FILTER + dateTrunc + upsert)",
    async (db) => {
      await dropTables(db, ["it_roll_events", "it_roll_hourly"]);
      const ev = defineTable("it_roll_events", {
        id: columns.integer().primaryKey(),
        post_id: columns.integer().notNull(),
        kind: columns.varchar(20).notNull(),
        occurred_at: columns.timestamp({ mode: "string" }).notNull(),
      });
      const hourly = defineTable("it_roll_hourly", {
        post_id: columns.integer().notNull(),
        bucket: columns.timestamp({ mode: "string" }).notNull(),
        views: columns.integer().notNull(),
        votes: columns.integer().notNull(),
        comments: columns.integer().notNull(),
        engagement: columns.doublePrecision().notNull(),
      }, (c) => [primaryKey({ columns: [c.post_id, c.bucket] })]);
      await applyTables(db, [ev, hourly]);

      await db.insert(ev).values([
        { id: 1, post_id: 1, kind: "view", occurred_at: "2026-01-01 10:05:00" },
        { id: 2, post_id: 1, kind: "view", occurred_at: "2026-01-01 10:10:00" },
        { id: 3, post_id: 1, kind: "view", occurred_at: "2026-01-01 10:20:00" },
        { id: 4, post_id: 1, kind: "vote", occurred_at: "2026-01-01 10:25:00" },
        { id: 5, post_id: 1, kind: "vote", occurred_at: "2026-01-01 10:40:00" },
        {
          id: 6,
          post_id: 1,
          kind: "comment",
          occurred_at: "2026-01-01 10:50:00",
        },
        { id: 7, post_id: 1, kind: "view", occurred_at: "2026-01-01 11:15:00" },
        { id: 8, post_id: 2, kind: "view", occurred_at: "2026-01-01 10:30:00" },
        { id: 9, post_id: 2, kind: "vote", occurred_at: "2026-01-01 10:35:00" },
        // Outside the half-open [10:00, 12:00) window — must not be folded.
        {
          id: 10,
          post_id: 2,
          kind: "view",
          occurred_at: "2026-01-01 12:30:00",
        },
      ]).execute();

      // The v0.6 ETL rollup spine as ONE builder statement: INSERT … SELECT
      // with CASE WHEN FILTER aggregates over DATE_FORMAT hour buckets,
      // upserted via ON DUPLICATE KEY UPDATE with values(col).
      const e = ev.columns;
      const bucket = dateTrunc("hour", e.occurred_at);
      const rollup = () =>
        db.insert(hourly).select(
          db.select({
            post_id: e.post_id,
            bucket,
            views: filter(count(), eq(e.kind, "view")),
            votes: filter(count(), eq(e.kind, "vote")),
            comments: filter(count(), eq(e.kind, "comment")),
            engagement: sql`${filter(count(), eq(e.kind, "vote"))} * 2.0 + ${
              filter(count(), eq(e.kind, "comment"))
            } * 3.0`,
          }).from(ev)
            .where(and(
              gte(e.occurred_at, "2026-01-01 10:00:00"),
              lt(e.occurred_at, "2026-01-01 12:00:00"),
            ))
            .groupBy(e.post_id, bucket),
        ).onConflictDoUpdate({
          target: [hourly.columns.post_id, hourly.columns.bucket],
          set: {
            views: excluded(hourly.columns.views),
            votes: excluded(hourly.columns.votes),
            comments: excluded(hourly.columns.comments),
            engagement: excluded(hourly.columns.engagement),
          },
        });

      const read = async () =>
        (await db.select().from(hourly)
          .orderBy(asc(hourly.columns.post_id), asc(hourly.columns.bucket))
          .execute())
          .map((r) => [
            Number(r.post_id),
            Number(r.views),
            Number(r.votes),
            Number(r.comments),
            Number(r.engagement),
          ]);

      // First run folds the window into 3 (post, hour) buckets.
      await rollup().execute();
      const first = await read();
      assertEquals(first, [
        [1, 3, 2, 1, 7], // post 1, 10:00 — engagement 2*2.0 + 1*3.0
        [1, 1, 0, 0, 0], // post 1, 11:00
        [2, 1, 1, 0, 2], // post 2, 10:00
      ]);

      // Idempotent: re-running the same window rewrites identical values.
      await rollup().execute();
      assertEquals(await read(), first);

      // A late event in the window: the re-run's DO UPDATE folds it in.
      await db.insert(ev).values(
        {
          id: 11,
          post_id: 1,
          kind: "vote",
          occurred_at: "2026-01-01 10:55:00",
        },
      ).execute();
      await rollup().execute();
      assertEquals((await read())[0], [1, 3, 3, 1, 9]);

      // Unlike the SQLite family, a BARE upsert-from-select parses fine on
      // MySQL — ON DUPLICATE KEY UPDATE is not ambiguous with a join ON.
      await db.insert(hourly).select(
        db.select({
          post_id: e.post_id,
          bucket,
          views: filter(count(), eq(e.kind, "view")),
          votes: filter(count(), eq(e.kind, "vote")),
          comments: filter(count(), eq(e.kind, "comment")),
          engagement: sql`0.0`,
        }).from(ev).groupBy(e.post_id, bucket),
      ).onConflictDoUpdate({
        target: [hourly.columns.post_id, hourly.columns.bucket],
        set: { views: excluded(hourly.columns.views) },
      }).execute();
    },
  );

  mysqlTest("mysql: schema objects (triggers/views)", async (db) => {
    await db.execute(raw("drop view if exists it_so_view"));
    await db.execute(raw("drop trigger if exists it_so_trg"));
    await dropTables(db, ["it_so", "it_so_count"]);

    const it_so = defineTable("it_so", {
      id: columns.integer().primaryKey(),
      label: columns.varchar(50).notNull(),
    });
    const it_so_count = defineTable("it_so_count", {
      id: columns.integer().primaryKey(),
      n: columns.integer().notNull(),
    });

    const snapshot = createSchemaSnapshot({
      dialect: "mysql",
      tables: [it_so, it_so_count],
      schemaObjects: [
        // Postgres-only — the mysql generator must skip this entirely.
        {
          name: "it_so_stamp",
          kind: "function",
          dialect: "postgres",
          up: "CREATE FUNCTION it_so_stamp() RETURNS trigger AS $$ $$ " +
            "LANGUAGE plpgsql;",
        },
        // MySQL trigger: single statement (DELIMITER is a client artifact).
        {
          name: "it_so_trg",
          kind: "trigger",
          dialect: "mysql",
          up: "CREATE TRIGGER it_so_trg AFTER INSERT ON it_so FOR EACH ROW " +
            "UPDATE it_so_count SET n = n + 1 WHERE id = 1;",
          down: "DROP TRIGGER it_so_trg;",
        },
        // Dialect-agnostic view.
        {
          name: "it_so_view",
          kind: "view",
          up: "CREATE VIEW it_so_view AS SELECT id, label FROM it_so;",
          down: "DROP VIEW it_so_view;",
        },
      ],
    });

    const { statements, destructive } = generateMysqlUp(snapshot);
    assertEquals(destructive.length, 0);
    assertEquals(statements.some((s) => s.includes("CREATE FUNCTION")), false);
    assert(statements[0].startsWith("CREATE TABLE `it_so`"));
    for (const statement of statements) await db.execute(statement);

    await db.insert(it_so_count).values({ id: 1, n: 0 }).execute();
    await db.insert(it_so).values([{ id: 1, label: "a" }, {
      id: 2,
      label: "b",
    }])
      .execute();

    // The AFTER INSERT trigger fired once per row.
    const [counter] = await db.select().from(it_so_count).execute();
    assertEquals(Number(counter.n), 2);

    // The view resolves against the table.
    const view = await db.query<{ count: number }>(
      sql`select count(*) as count from it_so_view`,
    );
    assertEquals(Number(view.rows[0].count), 2);
  });

  mysqlTest("mysql: typed guards (distinctOn / dm-CTE)", async (db) => {
    let error = await assertRejects(() =>
      db.select({ orgId: users.columns.orgId }).from(users)
        .distinctOn(users.columns.orgId).execute()
    );
    assertTypedGuard(error, "distinctOn");

    const moved = db.$with("moved").as(
      db.delete(users).where(eq(users.columns.id, 4))
        .returning({ id: users.columns.id }),
    );
    error = await assertRejects(() =>
      db.with(moved).select({ id: moved.id }).from(moved).execute()
    );
    assertTypedGuard(error, "data-modifying CTE");
  });

  mysqlTest("mysql: teardown", async () => {
    await currentTarget().close();
  });

  return scenarios;
}
