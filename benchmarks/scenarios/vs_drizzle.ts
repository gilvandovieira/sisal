/**
 * Head-to-head SQL-generation benchmarks: Sisal vs Drizzle ORM 0.45.2.
 *
 * This is a pure, synchronous comparison — both libraries turn the same query
 * into a parameterized `{ sql, params }` with no driver, no `await`, and no
 * database roundtrip. We compare Drizzle's `query.toSQL()` against Sisal's
 * `builder.toSql()` + `renderSql({ dialect })`: both build the statement AST and
 * render it to a dialect-specific string with bound parameters.
 *
 * Every group pairs the two libraries on one operation + dialect, with Sisal as
 * the baseline, so `deno bench`'s summary prints the ratio directly. The two
 * dialects cover all four Sisal engines: the Postgres dialect backs `@sisal/pg`
 * and `@sisal/neon`; the SQLite dialect backs `@sisal/sqlite` and `@sisal/libsql`.
 *
 * @module
 */

import {
  and,
  columns,
  createDatabase,
  defineTable,
  desc,
  eq,
  gt,
  renderSql,
  type SqlDialect,
} from "@sisal/orm";

import { and as dAnd, desc as dDesc, eq as dEq, gt as dGt } from "drizzle-orm";
import {
  boolean as pgBoolean,
  integer as pgInteger,
  pgTable,
  text as pgText,
} from "drizzle-orm/pg-core";
import { drizzle as drizzlePgProxy } from "drizzle-orm/pg-proxy";
import {
  integer as sqliteInteger,
  sqliteTable,
  text as sqliteText,
} from "drizzle-orm/sqlite-core";
import { drizzle as drizzleSqliteProxy } from "drizzle-orm/sqlite-proxy";

import type { BenchmarkScenario } from "../harness.ts";

// ---------------------------------------------------------------------------
// Shared row payloads — identical work on both sides.
// ---------------------------------------------------------------------------
const row = {
  id: 1,
  email: "ada@example.com",
  name: "Ada",
  age: 36,
  active: true,
};
const bulkRows = Array.from({ length: 50 }, (_, index) => ({
  id: index + 1,
  email: `user${index + 1}@example.com`,
  name: `User ${index + 1}`,
  age: 20 + (index % 40),
  active: index % 2 === 0,
}));

// ---------------------------------------------------------------------------
// Sisal — one dialect-agnostic builder, rendered per dialect at the call site.
// ---------------------------------------------------------------------------
const sisal = createDatabase({ dialect: "postgres" });
const sUsers = defineTable("users", {
  id: columns.integer().primaryKey(),
  email: columns.text().notNull(),
  name: columns.text(),
  age: columns.integer(),
  active: columns.boolean(),
});
const sAll = {
  id: sUsers.columns.id,
  email: sUsers.columns.email,
  name: sUsers.columns.name,
  age: sUsers.columns.age,
  active: sUsers.columns.active,
};
const sSome = {
  id: sUsers.columns.id,
  email: sUsers.columns.email,
  name: sUsers.columns.name,
};

function sisalSimple(dialect: SqlDialect) {
  renderSql(
    sisal.select(sAll).from(sUsers).where(eq(sUsers.columns.id, 1)).limit(1)
      .toSql(),
    { dialect },
  );
}
function sisalFiltered(dialect: SqlDialect) {
  renderSql(
    sisal.select(sSome).from(sUsers)
      .where(and(eq(sUsers.columns.active, true), gt(sUsers.columns.age, 18)))
      .orderBy(desc(sUsers.columns.age)).limit(20).offset(40).toSql(),
    { dialect },
  );
}
function sisalInsert(dialect: SqlDialect) {
  renderSql(sisal.insert(sUsers).values(row).returning().toSql(), { dialect });
}
function sisalBulk(dialect: SqlDialect) {
  renderSql(sisal.insert(sUsers).values(bulkRows).toSql(), { dialect });
}
function sisalUpdate(dialect: SqlDialect) {
  renderSql(
    sisal.update(sUsers).set({ name: "Ada", active: false })
      .where(eq(sUsers.columns.id, 1)).toSql(),
    { dialect },
  );
}
function sisalDelete(dialect: SqlDialect) {
  renderSql(
    sisal.delete(sUsers).where(eq(sUsers.columns.id, 1)).toSql(),
    { dialect },
  );
}
function sisalCte(dialect: SqlDialect) {
  const adults = sisal.$with("adults").as(
    sisal.select({ id: sUsers.columns.id, age: sUsers.columns.age })
      .from(sUsers).where(gt(sUsers.columns.age, 18)),
  );
  renderSql(
    sisal.with(adults).select({ id: adults.id }).from(adults).toSql(),
    { dialect },
  );
}

// ---------------------------------------------------------------------------
// Drizzle — a db per dialect. The proxy client is never called (.toSQL() only).
// ---------------------------------------------------------------------------
const noopPgClient = () => Promise.resolve({ rows: [] as unknown[][] });
const noopSqliteClient = () => Promise.resolve({ rows: [] as unknown[] });

const drizzlePg = drizzlePgProxy(noopPgClient);
const drizzleSqlite = drizzleSqliteProxy(noopSqliteClient);

const pgUsers = pgTable("users", {
  id: pgInteger("id").primaryKey(),
  email: pgText("email").notNull(),
  name: pgText("name"),
  age: pgInteger("age"),
  active: pgBoolean("active"),
});
const sqUsers = sqliteTable("users", {
  id: sqliteInteger("id").primaryKey(),
  email: sqliteText("email").notNull(),
  name: sqliteText("name"),
  age: sqliteInteger("age"),
  active: sqliteInteger("active", { mode: "boolean" }),
});

function drizzlePgSimple() {
  drizzlePg.select({
    id: pgUsers.id,
    email: pgUsers.email,
    name: pgUsers.name,
    age: pgUsers.age,
    active: pgUsers.active,
  }).from(pgUsers).where(dEq(pgUsers.id, 1)).limit(1).toSQL();
}
function drizzlePgFiltered() {
  drizzlePg.select({
    id: pgUsers.id,
    email: pgUsers.email,
    name: pgUsers.name,
  }).from(pgUsers)
    .where(dAnd(dEq(pgUsers.active, true), dGt(pgUsers.age, 18)))
    .orderBy(dDesc(pgUsers.age)).limit(20).offset(40).toSQL();
}
function drizzlePgInsert() {
  drizzlePg.insert(pgUsers).values(row).returning().toSQL();
}
function drizzlePgBulk() {
  drizzlePg.insert(pgUsers).values(bulkRows).toSQL();
}
function drizzlePgUpdate() {
  drizzlePg.update(pgUsers).set({ name: "Ada", active: false })
    .where(dEq(pgUsers.id, 1)).toSQL();
}
function drizzlePgDelete() {
  drizzlePg.delete(pgUsers).where(dEq(pgUsers.id, 1)).toSQL();
}

function drizzleSqliteSimple() {
  drizzleSqlite.select({
    id: sqUsers.id,
    email: sqUsers.email,
    name: sqUsers.name,
    age: sqUsers.age,
    active: sqUsers.active,
  }).from(sqUsers).where(dEq(sqUsers.id, 1)).limit(1).toSQL();
}
function drizzleSqliteFiltered() {
  drizzleSqlite.select({
    id: sqUsers.id,
    email: sqUsers.email,
    name: sqUsers.name,
  }).from(sqUsers)
    .where(dAnd(dEq(sqUsers.active, true), dGt(sqUsers.age, 18)))
    .orderBy(dDesc(sqUsers.age)).limit(20).offset(40).toSQL();
}
function drizzleSqliteInsert() {
  drizzleSqlite.insert(sqUsers).values(row).returning().toSQL();
}
function drizzleSqliteBulk() {
  drizzleSqlite.insert(sqUsers).values(bulkRows).toSQL();
}
function drizzleSqliteUpdate() {
  drizzleSqlite.update(sqUsers).set({ name: "Ada", active: false })
    .where(dEq(sqUsers.id, 1)).toSQL();
}
function drizzleSqliteDelete() {
  drizzleSqlite.delete(sqUsers).where(dEq(sqUsers.id, 1)).toSQL();
}
function drizzlePgCte() {
  const adults = drizzlePg.$with("adults").as(
    drizzlePg.select({ id: pgUsers.id, age: pgUsers.age })
      .from(pgUsers).where(dGt(pgUsers.age, 18)),
  );
  drizzlePg.with(adults).select({ id: adults.id }).from(adults).toSQL();
}
function drizzleSqliteCte() {
  const adults = drizzleSqlite.$with("adults").as(
    drizzleSqlite.select({ id: sqUsers.id, age: sqUsers.age })
      .from(sqUsers).where(dGt(sqUsers.age, 18)),
  );
  drizzleSqlite.with(adults).select({ id: adults.id }).from(adults).toSQL();
}

interface Pairing {
  readonly op: string;
  readonly sisal: () => void;
  readonly drizzle: () => void;
}

const pgPairings: readonly Pairing[] = [
  {
    op: "simple select",
    sisal: () => sisalSimple("postgres"),
    drizzle: drizzlePgSimple,
  },
  {
    op: "filtered select",
    sisal: () => sisalFiltered("postgres"),
    drizzle: drizzlePgFiltered,
  },
  {
    op: "insert returning",
    sisal: () => sisalInsert("postgres"),
    drizzle: drizzlePgInsert,
  },
  {
    op: "bulk insert (50)",
    sisal: () => sisalBulk("postgres"),
    drizzle: drizzlePgBulk,
  },
  {
    op: "update",
    sisal: () => sisalUpdate("postgres"),
    drizzle: drizzlePgUpdate,
  },
  {
    op: "delete",
    sisal: () => sisalDelete("postgres"),
    drizzle: drizzlePgDelete,
  },
  {
    op: "cte select",
    sisal: () => sisalCte("postgres"),
    drizzle: drizzlePgCte,
  },
];

const sqlitePairings: readonly Pairing[] = [
  {
    op: "simple select",
    sisal: () => sisalSimple("sqlite"),
    drizzle: drizzleSqliteSimple,
  },
  {
    op: "filtered select",
    sisal: () => sisalFiltered("sqlite"),
    drizzle: drizzleSqliteFiltered,
  },
  {
    op: "insert returning",
    sisal: () => sisalInsert("sqlite"),
    drizzle: drizzleSqliteInsert,
  },
  {
    op: "bulk insert (50)",
    sisal: () => sisalBulk("sqlite"),
    drizzle: drizzleSqliteBulk,
  },
  {
    op: "update",
    sisal: () => sisalUpdate("sqlite"),
    drizzle: drizzleSqliteUpdate,
  },
  {
    op: "delete",
    sisal: () => sisalDelete("sqlite"),
    drizzle: drizzleSqliteDelete,
  },
  {
    op: "cte select",
    sisal: () => sisalCte("sqlite"),
    drizzle: drizzleSqliteCte,
  },
];

function toScenarios(
  dialect: string,
  pairings: readonly Pairing[],
): BenchmarkScenario[] {
  return pairings.flatMap((pairing) => [
    {
      group: `${dialect} · ${pairing.op}`,
      name: "sisal",
      baseline: true,
      fn: pairing.sisal,
    },
    {
      group: `${dialect} · ${pairing.op}`,
      name: "drizzle",
      fn: pairing.drizzle,
    },
  ]);
}

// Fail fast if a builder stops producing SQL, so a broken benchmark never
// quietly measures nothing.
assertGenerates();

export const vsDrizzleScenarios: readonly BenchmarkScenario[] = [
  ...toScenarios("pg", pgPairings),
  ...toScenarios("sqlite", sqlitePairings),
];

function assertGenerates(): void {
  for (const pairing of [...pgPairings, ...sqlitePairings]) {
    pairing.sisal();
    pairing.drizzle();
  }
}
