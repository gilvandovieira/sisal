/**
 * Pure SQL-generation benchmarks.
 *
 * These measure how long Sisal takes to *produce* SQL — building the query AST,
 * rendering it to `{ text, params }`, creating schema snapshots, and generating
 * DDL — with no driver, no async, and no database roundtrip. They isolate the
 * library's own CPU cost; the fake-db-proxy scenarios cover the dispatch path.
 *
 * Groups cluster comparable work so `deno bench` shows relative cost:
 *  - "build vs render"  — where the time goes in one query
 *  - "statement kind"   — select / insert / update / delete / bulk insert
 *  - "select size"      — trivial vs a join+group+having+order query
 *  - "render dialect"   — Postgres ($1) vs SQLite (?) rendering of one AST
 *  - "operators"        — composing `and`/`or` over many conditions
 *  - "schema snapshot"  — snapshot creation as table count grows
 *  - "ddl"              — full CREATE vs additive diff vs SQLite
 *
 * @module
 */

import {
  and,
  asc,
  columns,
  count,
  createDatabase,
  createSchemaSnapshot,
  defineTable,
  desc,
  diffSchemaSnapshots,
  eq,
  gt,
  ilike,
  inArray,
  like,
  or,
  renderSql,
  type Sql,
  sum,
} from "@sisal/orm";
import { generatePostgresUpStatements } from "@sisal/pg/ddl";
import { generateSqliteUpStatements } from "@sisal/sqlite/ddl";

import type { BenchmarkScenario } from "../harness.ts";

// Builders are pure: toSql() never touches the (noop) driver.
const db = createDatabase({ dialect: "postgres" });

const orgs = defineTable("orgs", {
  id: columns.uuid().primaryKey(),
  name: columns.text().notNull(),
});

const users = defineTable("users", {
  id: columns.uuid().primaryKey(),
  email: columns.text().notNull().unique(),
  name: columns.text(),
  age: columns.integer(),
  active: columns.boolean(),
  orgId: columns.uuid().references("orgs", "id"),
  createdAt: columns.timestamp({ withTimezone: true }),
});

const posts = defineTable("posts", {
  id: columns.uuid().primaryKey(),
  authorId: columns.uuid().notNull().references("users", "id"),
  title: columns.text().notNull(),
});

const events = defineTable("events", {
  id: columns.integer().primaryKey(),
  kind: columns.text().notNull(),
  seq: columns.integer(),
});

function simpleSelect() {
  return db.select().from(users).where(eq(users.columns.id, "u_1")).limit(1);
}

function complexSelect() {
  return db.select({
    id: users.columns.id,
    email: users.columns.email,
    org: orgs.columns.name,
    posts: count(),
    ages: sum(users.columns.age),
  })
    .from(users)
    .leftJoin(orgs, eq(orgs.columns.id, users.columns.orgId))
    .innerJoin(posts, eq(posts.columns.authorId, users.columns.id))
    .where(and(
      eq(users.columns.active, true),
      gt(users.columns.age, 18),
      or(
        like(users.columns.email, "%@example.com"),
        ilike(users.columns.name, "a%"),
      ),
      inArray(users.columns.id, ["u_1", "u_2", "u_3", "u_4"]),
    ))
    .groupBy(users.columns.id, orgs.columns.name)
    .having(gt(count(), 1))
    .orderBy(desc(users.columns.createdAt), asc(users.columns.email))
    .limit(20)
    .offset(40);
}

function cteQuery() {
  const adults = db.$with("adults").as(
    db.select({ id: users.columns.id, age: users.columns.age })
      .from(users).where(gt(users.columns.age, 18)),
  );
  return db.with(adults).select({ id: adults.id, age: adults.age })
    .from(adults).orderBy(asc(adults.age)).limit(10);
}

function unionQuery() {
  const active = db.select({ id: users.columns.id }).from(users)
    .where(eq(users.columns.active, true));
  const adult = db.select({ id: users.columns.id }).from(users)
    .where(gt(users.columns.age, 18));
  return active.union(adult).orderBy(asc(users.columns.id));
}

function intersectQuery() {
  const active = db.select({ id: users.columns.id }).from(users)
    .where(eq(users.columns.active, true));
  const adult = db.select({ id: users.columns.id }).from(users)
    .where(gt(users.columns.age, 18));
  return active.intersect(adult).except(
    db.select({ id: users.columns.id }).from(users).where(
      eq(users.columns.id, "u_1"),
    ),
  );
}

const eventRow = { id: 1, kind: "click", seq: 1 };
const bulkRows = Array.from(
  { length: 100 },
  (_, index) => ({ id: index, kind: "click", seq: index }),
);

// Pre-built ASTs for render-only measurements.
const simpleAst: Sql = simpleSelect().toSql();
const complexAst: Sql = complexSelect().toSql();

// Snapshots for DDL/diff measurements.
const tablesFew = [orgs, users, posts];
const tablesMany = Array.from(
  { length: 12 },
  (_, index) =>
    defineTable(`t_${index}`, {
      id: columns.uuid().primaryKey(),
      a: columns.text().notNull(),
      b: columns.integer(),
      c: columns.boolean(),
      d: columns.timestamp(),
    }),
);
const pgSnapshot = createSchemaSnapshot({
  dialect: "postgres",
  tables: tablesFew,
});
const pgSnapshotPrev = createSchemaSnapshot({
  dialect: "postgres",
  tables: [orgs, users],
});

export const sqlGenerationScenarios: readonly BenchmarkScenario[] = [
  // ---- build vs render -----------------------------------------------------
  {
    group: "build vs render",
    name: "build simple select (toSql)",
    baseline: true,
    fn() {
      simpleSelect().toSql();
    },
  },
  {
    group: "build vs render",
    name: "render simple select (prebuilt AST)",
    fn() {
      renderSql(simpleAst, { dialect: "postgres" });
    },
  },
  {
    group: "build vs render",
    name: "build + render simple select",
    fn() {
      renderSql(simpleSelect().toSql(), { dialect: "postgres" });
    },
  },
  {
    group: "build vs render",
    name: "build + render complex select",
    fn() {
      renderSql(complexSelect().toSql(), { dialect: "postgres" });
    },
  },

  // ---- statement kind (full generation) ------------------------------------
  {
    group: "statement kind",
    name: "select",
    baseline: true,
    fn() {
      renderSql(simpleSelect().toSql(), { dialect: "postgres" });
    },
  },
  {
    group: "statement kind",
    name: "insert (single row, returning)",
    fn() {
      renderSql(
        db.insert(events).values(eventRow).returning().toSql(),
        { dialect: "postgres" },
      );
    },
  },
  {
    group: "statement kind",
    name: "insert (100 rows)",
    fn() {
      renderSql(
        db.insert(events).values(bulkRows).toSql(),
        { dialect: "postgres" },
      );
    },
  },
  {
    group: "statement kind",
    name: "update",
    fn() {
      renderSql(
        db.update(users).set({ name: "Ada", active: true })
          .where(eq(users.columns.id, "u_1")).toSql(),
        { dialect: "postgres" },
      );
    },
  },
  {
    group: "statement kind",
    name: "delete",
    fn() {
      renderSql(
        db.delete(users).where(eq(users.columns.id, "u_1")).toSql(),
        { dialect: "postgres" },
      );
    },
  },

  // ---- select size ---------------------------------------------------------
  {
    group: "select size",
    name: "trivial select",
    baseline: true,
    fn() {
      renderSql(simpleSelect().toSql(), { dialect: "postgres" });
    },
  },
  {
    group: "select size",
    name: "join + group + having + order select",
    fn() {
      renderSql(complexSelect().toSql(), { dialect: "postgres" });
    },
  },

  // ---- render dialect (same AST) -------------------------------------------
  {
    group: "render dialect",
    name: "postgres ($1, ILIKE)",
    baseline: true,
    fn() {
      renderSql(complexAst, { dialect: "postgres" });
    },
  },
  {
    group: "render dialect",
    name: "sqlite (?, ilike→like)",
    fn() {
      renderSql(complexAst, { dialect: "sqlite" });
    },
  },

  // ---- operators -----------------------------------------------------------
  {
    group: "operators",
    name: "and (4 conditions)",
    baseline: true,
    fn() {
      renderSql(manyConditions(4), { dialect: "postgres" });
    },
  },
  {
    group: "operators",
    name: "and (32 conditions)",
    fn() {
      renderSql(manyConditions(32), { dialect: "postgres" });
    },
  },

  // ---- ctes & set operations -----------------------------------------------
  {
    group: "cte / set ops",
    name: "build + render CTE",
    baseline: true,
    fn() {
      renderSql(cteQuery().toSql(), { dialect: "postgres" });
    },
  },
  {
    group: "cte / set ops",
    name: "build + render union (2 selects)",
    fn() {
      renderSql(unionQuery().toSql(), { dialect: "postgres" });
    },
  },
  {
    group: "cte / set ops",
    name: "build + render intersect + except (3 selects)",
    fn() {
      renderSql(intersectQuery().toSql(), { dialect: "postgres" });
    },
  },

  // ---- schema snapshot -----------------------------------------------------
  {
    group: "schema snapshot",
    name: "1 table",
    baseline: true,
    fn() {
      createSchemaSnapshot({ dialect: "postgres", tables: [users] });
    },
  },
  {
    group: "schema snapshot",
    name: "3 tables",
    fn() {
      createSchemaSnapshot({ dialect: "postgres", tables: tablesFew });
    },
  },
  {
    group: "schema snapshot",
    name: "12 tables",
    fn() {
      createSchemaSnapshot({ dialect: "postgres", tables: tablesMany });
    },
  },

  // ---- ddl generation ------------------------------------------------------
  {
    group: "ddl",
    name: "postgres full CREATE (3 tables)",
    baseline: true,
    fn() {
      generatePostgresUpStatements(pgSnapshot);
    },
  },
  {
    group: "ddl",
    name: "postgres additive diff (+1 table)",
    fn() {
      generatePostgresUpStatements(pgSnapshot, pgSnapshotPrev);
    },
  },
  {
    group: "ddl",
    name: "sqlite full CREATE (3 tables)",
    fn() {
      generateSqliteUpStatements(pgSnapshot);
    },
  },
  {
    group: "ddl",
    name: "snapshot diff only",
    fn() {
      diffSchemaSnapshots(pgSnapshotPrev, pgSnapshot);
    },
  },
];

function manyConditions(n: number): Sql {
  const conditions = Array.from(
    { length: n },
    (_, index) =>
      index % 2 === 0
        ? eq(users.columns.id, `u_${index}`)
        : gt(users.columns.age, index),
  );
  return db.select().from(users).where(and(...conditions)).toSql();
}
