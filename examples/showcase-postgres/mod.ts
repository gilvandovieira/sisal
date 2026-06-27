/**
 * PostgreSQL-class feature showcase for Sisal.
 *
 * The PostgreSQL dialect backs both `@sisal/pg` and `@sisal/neon`. A real
 * Postgres server needs a network connection, so this example is
 * **generation-first**: it runs anywhere with no database and prints the
 * artifacts Sisal produces — full-type `CREATE TABLE` DDL, additive/destructive
 * migration diffs, and the entire query-builder surface rendered as real
 * Postgres SQL (with `$1, $2` placeholders and native `ILIKE`).
 *
 * It also **executes** against a live server when `DATABASE_URL` is set, inside
 * a transaction that is rolled back so your database is left untouched. The
 * builder API is identical to the SQLite showcase — see
 * `examples/showcase-sqlite` for the full execution path.
 *
 *   # generation only (no permissions needed)
 *   deno run examples/showcase-postgres/mod.ts
 *
 *   # also execute against a scratch database
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/scratch \
 *     deno run --allow-env --allow-net examples/showcase-postgres/mod.ts
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
  max,
  min,
  ne,
  not,
  notInArray,
  or,
  renderSql,
  type Sql,
  sum,
} from "@sisal/orm";
import { planSchemaChanges } from "@sisal/migrate";
import { connect } from "@sisal/pg";
import { generatePostgresUpStatements } from "@sisal/pg/ddl";

// ---------------------------------------------------------------------------
// Schema — foreign keys, defaults, uniqueness, $onUpdate, and the full
// PostgreSQL type surface. Columns are nullable by default; `.notNull()` opts
// out and `.primaryKey()` implies not-null.
// ---------------------------------------------------------------------------
const orgs = defineTable("orgs", {
  id: columns.uuid().primaryKey(),
  name: columns.varchar(120).notNull(),
  plan: columns.text().notNull().default("free"),
  seats: columns.smallint().notNull().default(5),
});

const users = defineTable("users", {
  id: columns.uuid().primaryKey(),
  orgId: columns.uuid().references("orgs", "id"),
  email: columns.text().notNull().unique(),
  name: columns.text(),
  age: columns.integer(),
  active: columns.boolean().notNull().default(true),
  balance: columns.numeric(12, 2).notNull().default("0.00"),
  metadata: columns.jsonb<{ role?: string }>(),
  tags: columns.text().array(),
  createdAt: columns.timestamp({ withTimezone: true }).notNull(),
  // `$onUpdate` recomputes the value on every UPDATE.
  updatedAt: columns.timestamp({ withTimezone: true })
    .$onUpdate(() => new Date()),
});

const posts = defineTable("posts", {
  id: columns.serial().primaryKey(),
  authorId: columns.uuid().notNull().references("users", "id"),
  title: columns.text().notNull(),
  body: columns.text().optional(),
  views: columns.integer().notNull().default(0),
  rating: columns.doublePrecision().optional(),
});

// Exhaustive type table — shows how every column type maps to Postgres DDL.
const allTypes = defineTable("all_types", {
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
  c_tstz: columns.timestamp({ withTimezone: true }),
  c_uuid: columns.uuid(),
  c_text_arr: columns.text().array(),
  c_blob: columns.bytea(),
});

// `gen` is a driverless database used only to build statements and render their
// SQL — `.toSql()` never touches a connection.
const gen = createDatabase({ dialect: "postgres" });

function section(title: string): void {
  console.log(`\n══ ${title} ${"═".repeat(Math.max(0, 58 - title.length))}`);
}

function render(label: string, statement: Sql): void {
  const { text, params } = renderSql(statement, { dialect: "postgres" });
  console.log(`\n-- ${label}`);
  console.log(`${text};`);
  if (params.length > 0) {
    console.log(`   -- params: ${JSON.stringify(params)}`);
  }
}

function generation(): void {
  // ---- 1. Generated DDL across the full type surface ---------------------
  section("Generated DDL (full type surface)");
  const snapshot = createSchemaSnapshot({
    dialect: "postgres",
    tables: [orgs, users, posts, allTypes],
  });
  const created = generatePostgresUpStatements(snapshot);
  console.log(created.statements.join("\n\n"));

  // ---- 2. Migration diffs (additive + destructive) -----------------------
  section("Migration diffs");
  const v1 = createSchemaSnapshot({
    dialect: "postgres",
    tables: [
      defineTable("widgets", {
        id: columns.uuid().primaryKey(),
        name: columns.text().notNull(),
      }),
    ],
  });
  const v2 = createSchemaSnapshot({
    dialect: "postgres",
    tables: [
      defineTable("widgets", {
        id: columns.uuid().primaryKey(),
        name: columns.text().notNull(),
        color: columns.text(), // additive ALTER ADD COLUMN
      }),
      defineTable("audits", { // additive CREATE TABLE
        id: columns.uuid().primaryKey(),
        at: columns.timestamp({ withTimezone: true }).notNull(),
      }),
    ],
  });
  const additive = generatePostgresUpStatements(v2, v1);
  console.log("additive up:\n" + additive.statements.join("\n"));

  // `planSchemaChanges` classifies every change and flags destructive ones.
  const v3 = createSchemaSnapshot({
    dialect: "postgres",
    tables: [
      defineTable("widgets", { id: columns.uuid().primaryKey() }), // drops name
    ],
  });
  const plan = planSchemaChanges({ from: v2, to: v3 });
  console.log(
    "\nclassified changes:\n" +
      plan.changes.map((c) =>
        `  ${c.destructive ? "⚠ " : "  "}${c.kind} ${c.table}${
          c.column ? "." + c.column : ""
        }`
      ).join("\n"),
  );
  console.log(
    `\ngeneratePostgresUpStatements withholds ${
      generatePostgresUpStatements(v3, v2).destructive.length
    } destructive change(s).`,
  );

  // ---- 3. The query builder, rendered as Postgres SQL --------------------
  section("Query builder → Postgres SQL");

  render(
    "projection + comparison",
    gen.select({ id: users.columns.id, email: users.columns.email })
      .from(users).where(eq(users.columns.id, "u_1")).toSql(),
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
        notInArray(users.columns.id, ["u_9"]),
        isNotNull(users.columns.orgId),
      ),
    ).toSql(),
  );

  render(
    "pattern matching (native ILIKE)",
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
    "inner join with explicit projection",
    gen.select({ email: users.columns.email, org: orgs.columns.name })
      .from(users).innerJoin(orgs, eq(orgs.columns.id, users.columns.orgId))
      .toSql(),
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
    "multi-row insert + returning",
    gen.insert(users).values([
      {
        id: "u_1",
        orgId: "o_1",
        email: "ada@example.com",
        name: "Ada",
        age: 36,
        balance: "10.00",
        metadata: { role: "admin" },
        tags: ["founder"],
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: null,
      },
    ]).returning().toSql(),
  );

  render(
    "upsert (onConflictDoUpdate)",
    gen.insert(orgs).values({ id: "o_1", name: "Acme" })
      .onConflictDoUpdate({ target: orgs.columns.id, set: { plan: "team" } })
      .toSql(),
  );

  render(
    "update + returning (drives $onUpdate)",
    gen.update(users).set({ name: "Ada L." })
      .where(eq(users.columns.id, "u_1")).returning().toSql(),
  );

  render(
    "delete + returning",
    gen.delete(posts).where(lt(posts.columns.views, 1)).returning().toSql(),
  );
}

// Sentinel used to roll the live transaction back so nothing persists.
class Rollback extends Error {}

async function runLive(url: string): Promise<void> {
  section("Live execution (DATABASE_URL) — rolled back");
  const db = await connect({ url });
  const ddl = generatePostgresUpStatements(
    createSchemaSnapshot({ dialect: "postgres", tables: [orgs, users, posts] }),
  );
  try {
    await db.transaction(async (tx) => {
      for (const statement of ddl.statements) await tx.execute(statement);

      await tx.insert(orgs).values({
        id: "11111111-1111-1111-1111-111111111111",
        name: "Acme",
      })
        .execute();
      const inserted = await tx.insert(users).values({
        id: "22222222-2222-2222-2222-222222222222",
        orgId: "11111111-1111-1111-1111-111111111111",
        email: "ada@example.com",
        name: "Ada",
        age: 36,
        balance: "10.00",
        metadata: { role: "admin" },
        tags: ["founder"],
        createdAt: new Date(),
        updatedAt: null,
      }).returning().execute();
      console.log("inserted user id:", inserted.rows[0]?.id);

      const joined = await tx.select({
        email: users.columns.email,
        org: orgs.columns.name,
      }).from(users)
        .innerJoin(orgs, eq(orgs.columns.id, users.columns.orgId))
        .execute();
      console.log("joined row:", joined[0]);

      // jsonb and text[] come back parsed/typed on Postgres.
      const typed = await tx.select({
        metadata: users.columns.metadata,
        tags: users.columns.tags,
      }).from(users).execute();
      console.log("jsonb + array round-trip:", typed[0]);

      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
    console.log("transaction rolled back — database untouched.");
  } finally {
    await db.close();
  }
}

function databaseUrl(): string | undefined {
  try {
    return (globalThis as {
      Deno?: { env: { get(key: string): string | undefined } };
    }).Deno?.env.get("DATABASE_URL");
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  generation();

  const url = databaseUrl();
  if (url === undefined) {
    console.log(
      "\n(Set DATABASE_URL to also execute this against a scratch Postgres.)",
    );
    return;
  }
  await runLive(url);
  console.log("\n✓ Postgres showcase complete.");
}

if (import.meta.main) {
  await main();
}
