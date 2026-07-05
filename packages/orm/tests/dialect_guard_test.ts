/**
 * Render-time dialect guards (v0.5.0 roadmap item 4). The PostgreSQL-only
 * constructs — `distinctOn`, `.for(...)` row locking, and the array operators
 * (`@>`/`<@`/`&&`) — must throw a typed `OrmError` when rendered for a
 * SQLite-family dialect, instead of emitting SQL the engine rejects. Rendering
 * for `postgres` is unchanged.
 *
 * @module
 */
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  arrayContained,
  arrayContains,
  arrayOverlaps,
  columns,
  createDatabase,
  defineTable,
  OrmError,
  renderSql,
  type Sql,
  toSql,
} from "../mod.ts";

const db = createDatabase({ dialect: "postgres" });

const users = defineTable("users", {
  id: columns.integer().primaryKey(),
  name: columns.text(),
  tags: columns.text().array(),
});

// Renders cleanly on Postgres, throws a typed OrmError on a SQLite-family
// dialect naming the construct and the dialect.
function assertPgOkSqliteRejects(fragment: Sql, construct: string): void {
  renderSql(fragment, { dialect: "postgres" }); // no throw
  const error = assertThrows(
    () => renderSql(fragment, { dialect: "sqlite" }),
    OrmError,
    construct,
  );
  assertEquals((error as OrmError).code, "ORM_DIALECT_UNSUPPORTED");
  assertStringIncludes((error as Error).message, "sqlite");
}

Deno.test("dialect guard: distinctOn is PostgreSQL-only", () => {
  const query = db.select().from(users).distinctOn(users.columns.name).toSql();
  assertPgOkSqliteRejects(query, "distinctOn");
});

Deno.test("dialect guard: .for(...) row locking is PostgreSQL-only", () => {
  assertPgOkSqliteRejects(
    db.select().from(users).for("update").toSql(),
    "row locking",
  );
  assertPgOkSqliteRejects(
    db.select().from(users).for("share").toSql(),
    "row locking",
  );
});

Deno.test("dialect guard: array operators are PostgreSQL-only", () => {
  assertPgOkSqliteRejects(
    toSql(arrayContains(users.columns.tags, ["a", "b"])),
    "arrayContains",
  );
  assertPgOkSqliteRejects(
    toSql(arrayContained(users.columns.tags, ["a", "b"])),
    "arrayContained",
  );
  assertPgOkSqliteRejects(
    toSql(arrayOverlaps(users.columns.tags, ["a", "b"])),
    "arrayOverlaps",
  );
});

Deno.test("dialect guard: ordinary queries still render on sqlite", () => {
  // A guard is zero-width: queries without a Postgres-only construct are
  // unaffected and render normally on the SQLite-family dialect.
  const query = db.select().from(users).toSql();
  const rendered = renderSql(query, { dialect: "sqlite" });
  assertStringIncludes(rendered.text, "from");
});
