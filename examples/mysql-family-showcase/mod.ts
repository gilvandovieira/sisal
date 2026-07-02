/**
 * MySQL-**family** feature showcase for Sisal.
 *
 * Generation-first: this runs with no database and prints MySQL/MariaDB DDL,
 * additive/destructive migration diffs, and query-builder SQL rendered with
 * backticks, `?` placeholders, `ON DUPLICATE KEY UPDATE`, and typed guards for
 * unsupported constructs such as MySQL proper `RETURNING`.
 *
 * Set `MYSQL_URL`, `MARIADB_URL`, or `DATABASE_URL` to also execute a compact
 * live tour. Pick the driver with `SISAL_ADAPTER=mysql2` (default) or
 * `SISAL_ADAPTER=mariadb`.
 *
 *   deno run --allow-read examples/mysql-family-showcase/mod.ts
 *
 *   MYSQL_URL=mysql://root:root@localhost:33084/sisal \
 *     deno run --allow-env --allow-net --allow-read \
 *     examples/mysql-family-showcase/mod.ts
 *
 * MySQL DDL implicitly commits, so the live tour creates `sisal_showcase_*`
 * tables and drops them in `finally` instead of pretending a rollback can undo
 * schema changes.
 *
 * @module
 */

import {
  and,
  asc,
  avg,
  between,
  columns,
  count,
  createDatabase,
  createSchemaSnapshot,
  dateTrunc,
  defineTable,
  desc,
  eq,
  excluded,
  filter,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  max,
  min,
  ne,
  not,
  notInArray,
  or,
  OrmError,
  primaryKey,
  raw,
  renderSql,
  type Sql,
  sql,
  sum,
} from "@sisal/orm";
import { planSchemaChanges } from "@sisal/migrate";
import {
  connect,
  generateMysqlUpStatements,
  insertReturning,
  type MysqlDatabase,
  type MysqlDriverKind,
} from "@sisal/mysql";

const orgs = defineTable("sisal_showcase_orgs", {
  id: columns.serial().primaryKey(),
  name: columns.varchar(120).notNull(),
  plan: columns.varchar(40).notNull().default("free"),
  seats: columns.smallint().notNull().default(5),
});

const users = defineTable("sisal_showcase_users", {
  id: columns.serial().primaryKey(),
  orgId: columns.integer().references("sisal_showcase_orgs", "id"),
  email: columns.varchar(255).notNull().unique(),
  name: columns.varchar(120),
  age: columns.integer(),
  active: columns.boolean().notNull().default(true),
  balance: columns.numeric(12, 2).notNull().default("0.00"),
  metadata: columns.json<{ role?: string }>(),
  tags: columns.text().array(),
  createdAt: columns.timestamp({ mode: "string" }).notNull(),
  updatedAt: columns.timestamp({ mode: "string" })
    .$onUpdate(() => mysqlTimestamp(new Date())),
});

const posts = defineTable("sisal_showcase_posts", {
  id: columns.serial().primaryKey(),
  authorId: columns.integer().notNull().references(
    "sisal_showcase_users",
    "id",
  ),
  title: columns.varchar(255).notNull(),
  body: columns.text().optional(),
  views: columns.integer().notNull().default(0),
  rating: columns.doublePrecision().optional(),
});

const events = defineTable("sisal_showcase_events", {
  id: columns.serial().primaryKey(),
  postId: columns.integer().notNull(),
  kind: columns.varchar(20).notNull(),
  occurredAt: columns.timestamp({ mode: "string" }).notNull(),
});

const hourly = defineTable("sisal_showcase_hourly", {
  postId: columns.integer().notNull(),
  bucket: columns.timestamp({ mode: "string" }).notNull(),
  views: columns.integer().notNull(),
  votes: columns.integer().notNull(),
  comments: columns.integer().notNull(),
  engagement: columns.doublePrecision().notNull(),
}, (c) => [primaryKey({ columns: [c.postId, c.bucket] })]);

const allTypes = defineTable("sisal_showcase_all_types", {
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
  c_date: columns.date({ mode: "string" }),
  c_time: columns.time({ mode: "string" }),
  c_ts: columns.timestamp({ mode: "string" }),
  c_tstz: columns.timestamp({ withTimezone: true, mode: "string" }),
  c_uuid: columns.uuid(),
  c_text_arr: columns.text().array(),
  c_blob: columns.bytea(),
});

const gen = createDatabase({ dialect: "mysql" });

function section(title: string): void {
  console.log(`\n== ${title} ${"=".repeat(Math.max(0, 60 - title.length))}`);
}

function render(label: string, statement: Sql): void {
  console.log(`\n-- ${label}`);
  try {
    const { text, params } = renderSql(statement, { dialect: "mysql" });
    console.log(`${text};`);
    if (params.length > 0) {
      console.log(`   -- params: ${JSON.stringify(params)}`);
    }
  } catch (error) {
    if (error instanceof OrmError) {
      console.log(`typed guard: ${error.code} - ${error.message}`);
      return;
    }
    throw error;
  }
}

function generation(): void {
  section("Generated DDL (full type surface)");
  const snapshot = createSchemaSnapshot({
    dialect: "mysql",
    tables: [orgs, users, posts, events, hourly, allTypes],
  });
  const created = generateMysqlUpStatements(snapshot);
  console.log(created.statements.join("\n\n"));

  section("Migration diffs");
  const v1 = createSchemaSnapshot({
    dialect: "mysql",
    tables: [
      defineTable("sisal_widgets", {
        id: columns.serial().primaryKey(),
        name: columns.varchar(120).notNull(),
      }),
    ],
  });
  const v2 = createSchemaSnapshot({
    dialect: "mysql",
    tables: [
      defineTable("sisal_widgets", {
        id: columns.serial().primaryKey(),
        name: columns.varchar(120).notNull(),
        color: columns.varchar(40),
      }),
      defineTable("sisal_audits", {
        id: columns.serial().primaryKey(),
        at: columns.timestamp({ mode: "string" }).notNull(),
      }),
    ],
  });
  const additive = generateMysqlUpStatements(v2, v1);
  console.log("additive up:\n" + additive.statements.join("\n"));

  const v3 = createSchemaSnapshot({
    dialect: "mysql",
    tables: [
      defineTable("sisal_widgets", { id: columns.serial().primaryKey() }),
    ],
  });
  const plan = planSchemaChanges({ from: v2, to: v3 });
  console.log(
    "\nclassified changes:\n" +
      plan.changes.map((c) =>
        `  ${c.destructive ? "! " : "  "}${c.kind} ${c.table}${
          c.column ? "." + c.column : ""
        }`
      ).join("\n"),
  );
  console.log(
    `\ngenerateMysqlUpStatements withholds ${
      generateMysqlUpStatements(v3, v2).destructive.length
    } destructive change(s).`,
  );

  section("Query builder -> MySQL SQL");
  render(
    "projection + comparison",
    gen.select({ id: users.columns.id, email: users.columns.email })
      .from(users).where(eq(users.columns.id, 1)).toSql(),
  );
  render(
    "boolean logic + comparison operators",
    gen.select().from(users).where(
      and(
        gte(users.columns.age, 18),
        lt(users.columns.age, 65),
        or(eq(users.columns.active, true), ne(users.columns.name, "system")),
        not(isNull(users.columns.email)),
      ),
    ).toSql(),
  );
  render(
    "range / set / null operators",
    gen.select().from(users).where(
      and(
        between(users.columns.age, 21, 40),
        inArray(users.columns.name, ["Ada", "Bob"]),
        notInArray(users.columns.id, [99]),
        isNotNull(users.columns.orgId),
      ),
    ).toSql(),
  );
  render(
    "pattern matching (ILIKE degrades to LIKE)",
    gen.select().from(users).where(
      or(
        like(users.columns.email, "%@acme.com"),
        ilike(users.columns.name, "a%"),
      ),
    ).toSql(),
  );
  render(
    "ordering + limit/offset + distinct",
    gen.select({ orgId: users.columns.orgId }).from(users).distinct()
      .orderBy(desc(users.columns.balance), asc(users.columns.email))
      .limit(20).offset(40).toSql(),
  );
  render(
    "aggregates + groupBy + having",
    gen.select({
      orgId: users.columns.orgId,
      members: count(),
      avgAge: avg(users.columns.age),
      total: sum(users.columns.balance),
      youngest: min(users.columns.age),
      oldest: max(users.columns.age),
    }).from(users).where(isNotNull(users.columns.orgId))
      .groupBy(users.columns.orgId).having(gt(count(), 1)).toSql(),
  );
  render(
    "upsert (onConflictDoUpdate -> ON DUPLICATE KEY UPDATE)",
    gen.insert(orgs).values({ id: 1, name: "Acme" })
      .onConflictDoUpdate({ target: orgs.columns.id, set: { plan: "team" } })
      .toSql(),
  );
  render(
    "insert + returning (typed guard on base MySQL identity)",
    gen.insert(users).values({
      orgId: 1,
      email: "ada@example.com",
      name: "Ada",
      age: 36,
      balance: "10.00",
      metadata: { role: "admin" },
      tags: ["founder"],
      createdAt: mysqlTimestamp(new Date("2026-01-01T00:00:00Z")),
      updatedAt: null,
    }).returning().toSql(),
  );
  render(
    "ETL rollup insert-from-select + FILTER + dateTrunc + upsert",
    rollupStatement().toSql(),
  );
}

function rollupStatement() {
  const e = events.columns;
  const h = hourly.columns;
  const bucket = dateTrunc("hour", e.occurredAt);
  return gen.insert(hourly).select(
    gen.select({
      postId: e.postId,
      bucket,
      views: filter(count(), eq(e.kind, "view")),
      votes: filter(count(), eq(e.kind, "vote")),
      comments: filter(count(), eq(e.kind, "comment")),
      engagement: sql`${filter(count(), eq(e.kind, "vote"))} * 2.0 + ${
        filter(count(), eq(e.kind, "comment"))
      } * 3.0`,
    }).from(events)
      .where(and(
        gte(e.occurredAt, "2026-01-01 10:00:00.000000"),
        lt(e.occurredAt, "2026-01-01 12:00:00.000000"),
      ))
      .groupBy(e.postId, bucket),
  ).onConflictDoUpdate({
    target: [h.postId, h.bucket],
    set: {
      views: excluded(h.views),
      votes: excluded(h.votes),
      comments: excluded(h.comments),
      engagement: excluded(h.engagement),
    },
  });
}

async function runLive(url: string): Promise<void> {
  const adapter = mysqlAdapter();
  section(`Live execution (${adapter}); cleanup uses DROP TABLE`);
  const db = await connect({ url, driver: adapter });
  try {
    await cleanup(db);
    const ddl = generateMysqlUpStatements(
      createSchemaSnapshot({
        dialect: "mysql",
        tables: [orgs, users, posts, events, hourly],
      }),
    );
    for (const statement of ddl.statements) await db.execute(statement);

    await db.insert(orgs).values([
      { name: "Acme", plan: "pro" },
      { name: "Globex", plan: "free" },
    ]).execute();

    const inserted = await insertReturning(db, users, {
      orgId: 1,
      email: "ada@example.com",
      name: "Ada",
      age: 36,
      balance: "98.50",
      metadata: { role: "admin" },
      tags: ["founder", "ops"],
      createdAt: "2026-01-01 09:00:00.000000",
      updatedAt: null,
    });
    console.log("insertReturning user:", inserted[0]);

    await db.insert(users).values([
      {
        orgId: 1,
        email: "bob@example.com",
        name: "Bob",
        age: 17,
        balance: "5.00",
        metadata: null,
        tags: ["support"],
        createdAt: "2026-01-01 09:05:00.000000",
        updatedAt: null,
      },
      {
        orgId: 2,
        email: "cara@example.com",
        name: "Cara",
        age: 41,
        balance: "12.00",
        metadata: { role: "owner" },
        tags: [],
        createdAt: "2026-01-01 09:10:00.000000",
        updatedAt: null,
      },
    ]).execute();

    const joined = await db.select({
      email: users.columns.email,
      org: orgs.columns.name,
    }).from(users)
      .innerJoin(orgs, eq(orgs.columns.id, users.columns.orgId))
      .orderBy(asc(users.columns.id))
      .execute();
    console.log("joined rows:", joined);

    await db.insert(orgs).values({ id: 1, name: "ignored" })
      .onConflictDoUpdate({ target: orgs.columns.id, set: { plan: "team" } })
      .execute();
    const acme = await db.select({ plan: orgs.columns.plan }).from(orgs)
      .where(eq(orgs.columns.id, 1)).execute();
    console.log("Acme plan after upsert:", acme[0]?.plan);

    const counted = await db.query<{ n: number }>(
      sql`select count(*) as n from sisal_showcase_users where active = ${1}`,
    );
    console.log("active users:", Number(counted.rows[0].n));

    await db.insert(events).values([
      { postId: 1, kind: "view", occurredAt: "2026-01-01 10:05:00.000000" },
      { postId: 1, kind: "view", occurredAt: "2026-01-01 10:10:00.000000" },
      { postId: 1, kind: "vote", occurredAt: "2026-01-01 10:25:00.000000" },
      { postId: 1, kind: "comment", occurredAt: "2026-01-01 10:50:00.000000" },
      { postId: 2, kind: "view", occurredAt: "2026-01-01 11:15:00.000000" },
    ]).execute();
    await rollupStatementFor(db).execute();
    console.log(
      "hourly rollup:",
      await db.select().from(hourly)
        .orderBy(asc(hourly.columns.postId), asc(hourly.columns.bucket))
        .execute(),
    );

    // MariaDB parses WITH only on SELECT (a CTE-prefixed mutation is a typed
    // guard), so the multi-table update uses a derived table there.
    if (db.dialectIdentity.variant === "mariadb") {
      const big = db.select({ id: posts.columns.id }).from(posts)
        .where(gte(posts.columns.views, 10)).as("big");
      await db.update(posts).set({ rating: 5 })
        .from(big).where(eq(posts.columns.id, big.id)).execute();
    } else {
      const big = db.$with("big").as(
        db.select({ id: posts.columns.id }).from(posts)
          .where(gte(posts.columns.views, 10)),
      );
      await db.with(big).update(posts).set({ rating: 5 })
        .from(big).where(eq(posts.columns.id, big.id)).execute();
    }

    console.log(`\n✓ MySQL-family showcase complete (via ${adapter}).`);
  } finally {
    await cleanup(db);
    await db.close();
  }
}

function rollupStatementFor(db: MysqlDatabase) {
  const e = events.columns;
  const h = hourly.columns;
  const bucket = dateTrunc("hour", e.occurredAt);
  return db.insert(hourly).select(
    db.select({
      postId: e.postId,
      bucket,
      views: filter(count(), eq(e.kind, "view")),
      votes: filter(count(), eq(e.kind, "vote")),
      comments: filter(count(), eq(e.kind, "comment")),
      engagement: sql`${filter(count(), eq(e.kind, "vote"))} * 2.0 + ${
        filter(count(), eq(e.kind, "comment"))
      } * 3.0`,
    }).from(events)
      .where(and(
        gte(e.occurredAt, "2026-01-01 10:00:00.000000"),
        lt(e.occurredAt, "2026-01-01 12:00:00.000000"),
      ))
      .groupBy(e.postId, bucket),
  ).onConflictDoUpdate({
    target: [h.postId, h.bucket],
    set: {
      views: excluded(h.views),
      votes: excluded(h.votes),
      comments: excluded(h.comments),
      engagement: excluded(h.engagement),
    },
  });
}

async function cleanup(db: MysqlDatabase): Promise<void> {
  await db.execute(raw("drop table if exists sisal_showcase_hourly"));
  await db.execute(raw("drop table if exists sisal_showcase_events"));
  await db.execute(raw("drop table if exists sisal_showcase_posts"));
  await db.execute(raw("drop table if exists sisal_showcase_users"));
  await db.execute(raw("drop table if exists sisal_showcase_orgs"));
}

function mysqlTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "000");
}

function readEnv(name: string): string | undefined {
  try {
    return (globalThis as {
      Deno?: { env: { get(key: string): string | undefined } };
    }).Deno?.env.get(name);
  } catch {
    return undefined;
  }
}

function databaseUrl(): string | undefined {
  return readEnv("MYSQL_URL") ?? readEnv("MARIADB_URL") ??
    readEnv("DATABASE_URL");
}

function mysqlAdapter(): MysqlDriverKind {
  const rawAdapter = (readEnv("SISAL_ADAPTER") ?? "mysql2").trim();
  if (rawAdapter === "mysql2" || rawAdapter === "mariadb") return rawAdapter;
  throw new Error(
    `Unknown SISAL_ADAPTER "${rawAdapter}"; use "mysql2" or "mariadb".`,
  );
}

async function main(): Promise<void> {
  generation();
  const url = databaseUrl();
  if (url === undefined) {
    console.log(
      "\n(Set MYSQL_URL, MARIADB_URL, or DATABASE_URL to also execute this " +
        "against a scratch database; SISAL_ADAPTER=mysql2|mariadb picks the " +
        "driver.)",
    );
    return;
  }
  await runLive(url);
}

if (import.meta.main) {
  await main();
}
