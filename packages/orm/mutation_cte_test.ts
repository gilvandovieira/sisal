/**
 * Item 12 core: data-modifying CTEs that reference other relations + the
 * mutating terminal. `db.with(...)` can now terminate in `update`/`insert`/
 * `delete` (not only `select`); `update().from()` / `delete().using()` /
 * `insert().select()` let a mutation read another CTE's `RETURNING`. `UPDATE …
 * FROM` and `INSERT … SELECT` run on every adapter; `DELETE … USING` runs on
 * PostgreSQL and the MySQL family (a typed guard throws on the SQLite family).
 *
 * @module
 */
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  columns,
  createDatabase,
  defineTable,
  eq,
  gt,
  OrmError,
  renderSql,
} from "./mod.ts";

const db = createDatabase({ dialect: "postgres" });

const posts = defineTable("posts", {
  id: columns.integer().primaryKey(),
  score: columns.integer().notNull(),
});
const archive = defineTable("archive", {
  id: columns.integer().primaryKey(),
  score: columns.integer().notNull(),
});

const scores = db.$with("scores").as(
  db.select({ id: posts.columns.id, s: posts.columns.score }).from(posts),
);

Deno.test("mutating terminal: with(...).update prepends the WITH", () => {
  const q = db.with(scores).update(posts).set({ score: 0 })
    .where(eq(posts.columns.id, scores.id)).returning();
  assertStringIncludes(
    renderSql(q.toSql(), { dialect: "postgres" }).text,
    'with "scores" as (',
  );
  assertStringIncludes(
    renderSql(q.toSql(), { dialect: "postgres" }).text,
    'update "posts" set "score" = $1',
  );
});

Deno.test("update().from(): UPDATE … FROM a CTE, on every dialect", () => {
  const q = db.with(scores).update(posts).set({ score: 0 })
    .from(scores).where(eq(posts.columns.id, scores.id)).returning();
  const pg = renderSql(q.toSql(), { dialect: "postgres" }).text;
  assertStringIncludes(pg, 'from "scores" where "posts"."id" = "scores"."id"');
  // UPDATE … FROM is supported by the SQLite family too (no guard).
  assertStringIncludes(
    renderSql(q.toSql(), { dialect: "sqlite" }).text,
    'from "scores"',
  );
});

Deno.test("delete().using(): DELETE … USING maps per supported dialect", () => {
  const q = db.with(scores).delete(posts).using(scores)
    .where(eq(posts.columns.id, scores.id));
  assertStringIncludes(
    renderSql(q.toSql(), { dialect: "postgres" }).text,
    'delete from "posts" using "scores"',
  );
  assertStringIncludes(
    renderSql(q.toSql(), { dialect: "mysql" }).text,
    "delete from `posts` using `posts`, `scores`",
  );
  const error = assertThrows(
    () => renderSql(q.toSql(), { dialect: "sqlite" }),
    OrmError,
    "DELETE",
  );
  assertEquals((error as OrmError).code, "ORM_DIALECT_UNSUPPORTED");
});

Deno.test("insert().select(): chained data-modifying CTE (read a RETURNING)", () => {
  const moved = db.$with("moved").as(
    db.delete(posts).where(gt(posts.columns.score, 100))
      .returning({ id: posts.columns.id, score: posts.columns.score }),
  );
  const q = db.with(moved).insert(archive).select(
    db.select({ id: moved.id, score: moved.score }).from(moved),
  );
  const sql = renderSql(q.toSql(), { dialect: "postgres" }).text;
  assertStringIncludes(sql, 'with "moved" as (delete from "posts"');
  assertStringIncludes(sql, 'insert into "archive" ("id", "score") select');
  assertStringIncludes(sql, 'from "moved"');
});

Deno.test("data-modifying CTE body: PostgreSQL-only, guarded elsewhere (T18)", () => {
  // A `WITH x AS (DELETE … RETURNING) …` body is PostgreSQL/Neon-only; the
  // SQLite and MySQL families render CTEs as SELECT-only, so a data-modifying
  // body throws a typed guard at render time.
  const moved = db.$with("moved").as(
    db.delete(posts).where(gt(posts.columns.score, 100))
      .returning({ id: posts.columns.id }),
  );
  const q = db.with(moved).insert(archive).select(
    db.select({ id: moved.id }).from(moved),
  );
  // Renders on PostgreSQL.
  assertStringIncludes(
    renderSql(q.toSql(), { dialect: "postgres" }).text,
    'with "moved" as (delete from "posts"',
  );
  // Guarded on the SQLite and MySQL families.
  for (const dialect of ["sqlite", "mysql"] as const) {
    const error = assertThrows(
      () => renderSql(q.toSql(), { dialect }),
      OrmError,
      "data-modifying CTE",
    );
    assertEquals((error as OrmError).code, "ORM_DIALECT_UNSUPPORTED");
  }
});

Deno.test("insert(): .values() and .select() are mutually exclusive", () => {
  const builder = db.insert(archive)
    .values({ id: 1, score: 1 })
    .select(
      db.select({ id: posts.columns.id, score: posts.columns.score }).from(
        posts,
      ),
    );
  assertThrows(() => builder.toSql(), OrmError, "values");
});

Deno.test("insert().select(): rejects a key that is not a column of the table", () => {
  assertThrows(
    () =>
      db.insert(archive).select(
        // `bogus` is not a column of `archive`.
        db.select({ bogus: posts.columns.id }).from(posts),
      ),
    OrmError,
  );
});
