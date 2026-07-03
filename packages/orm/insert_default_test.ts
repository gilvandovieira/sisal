/**
 * Tests for multi-row INSERT rows with omitted columns: a row missing a
 * column another row provides renders the standard `DEFAULT` keyword (so the
 * column's database default applies) instead of binding an explicit NULL,
 * and the SQLite family — which has no `DEFAULT` in `VALUES` — fails closed.
 */
import { assertEquals, assertThrows } from "@std/assert";
import {
  columns,
  createDatabase,
  defineTable,
  OrmError,
  renderSql,
  sql,
} from "./mod.ts";

const db = createDatabase({ dialect: "postgres" });

const events = defineTable("events", {
  id: columns.integer().primaryKey(),
  score: columns.integer().notNull().default(0),
  note: columns.text().optional(),
});

Deno.test("insert: a row omitting a defaulted column renders DEFAULT, not NULL", () => {
  const rendered = renderSql(
    db.insert(events).values([
      { id: 1, score: 5, note: "a" },
      { id: 2, note: "b" }, // score omitted: the database default must apply
    ]).toSql(),
    { dialect: "postgres" },
  );

  assertEquals(
    rendered.text,
    'insert into "events" ("id", "score", "note") values ' +
      "($1, $2, $3), ($4, default, $5)",
  );
  assertEquals(rendered.params, [1, 5, "a", 2, "b"]);
});

Deno.test("insert: an explicit undefined value counts as omitted", () => {
  const rendered = renderSql(
    db.insert(events).values([
      { id: 1, score: 5 },
      { id: 2, score: undefined },
    ]).toSql(),
    { dialect: "postgres" },
  );

  assertEquals(
    rendered.text,
    'insert into "events" ("id", "score") values ($1, $2), ($3, default)',
  );
  assertEquals(rendered.params, [1, 5, 2]);
});

Deno.test("insert: omitted columns render DEFAULT on mysql and generic", () => {
  const query = db.insert(events).values([
    { id: 1, score: 5 },
    { id: 2 },
  ]).toSql();

  assertEquals(
    renderSql(query, { dialect: "mysql" }).text,
    "insert into `events` (`id`, `score`) values (?, ?), (?, default)",
  );
  assertEquals(
    renderSql(query, { dialect: "generic" }).text,
    'insert into "events" ("id", "score") values (?, ?), (?, default)',
  );
});

Deno.test("insert: heterogeneous rows fail closed on the sqlite family", () => {
  const query = db.insert(events).values([
    { id: 1, score: 5 },
    { id: 2 },
  ]).toSql();

  const error = assertThrows(
    () => renderSql(query, { dialect: "sqlite" }),
    OrmError,
    "INSERT … VALUES with omitted columns",
  );
  assertEquals(error.code, "ORM_DIALECT_UNSUPPORTED");
});

Deno.test("insert: homogeneous multi-row inserts stay unchanged on sqlite", () => {
  const rendered = renderSql(
    db.insert(events).values([
      { id: 1, score: 5 },
      { id: 2, score: 6 },
    ]).toSql(),
    { dialect: "sqlite" },
  );

  assertEquals(
    rendered.text,
    'insert into "events" ("id", "score") values (?, ?), (?, ?)',
  );
  assertEquals(rendered.params, [1, 5, 2, 6]);
});

Deno.test("insert: sql expression values still render inline next to DEFAULT", () => {
  const rendered = renderSql(
    db.insert(events).values([
      { id: 1, score: sql`1 + 2` },
      { id: 2 },
    ]).toSql(),
    { dialect: "postgres" },
  );

  assertEquals(
    rendered.text,
    'insert into "events" ("id", "score") values ($1, 1 + 2), ($2, default)',
  );
  assertEquals(rendered.params, [1, 2]);
});
