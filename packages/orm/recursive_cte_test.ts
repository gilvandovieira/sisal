/**
 * Recursive CTEs (v0.8 item 11): `db.$withRecursive(name, columns)` renders
 * `WITH RECURSIVE name (columns) AS (base UNION ALL step)` with the
 * self-reference usable as a source, the portable depth-guard pattern, and
 * one `RECURSIVE` keyword covering mixed plain/recursive lists.
 */
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  columns,
  createDatabase,
  defineTable,
  eq,
  lt,
  OrmError,
  renderSql,
  sql,
} from "./mod.ts";

const db = createDatabase({ dialect: "postgres" });

const comments = defineTable("comments", {
  id: columns.integer().primaryKey(),
  parentId: columns.integer(),
});
const c = comments.columns;

Deno.test("recursive CTE: base UNION ALL step with depth guard", () => {
  const tree = db.$withRecursive("thread", ["id", "depth"]).as((self) =>
    db.select({ id: c.id, depth: sql`1` }).from(comments)
      .where(eq(c.id, 7))
      .unionAll(
        db.select({ id: c.id, depth: sql`${self.depth} + 1` }).from(comments)
          .innerJoin(comments, eq(c.parentId, self.id))
          .where(lt(self.depth, 5)),
      )
  );
  const rendered = renderSql(
    db.with(tree).select({ id: tree.id }).from(tree).toSql(),
    { dialect: "postgres" },
  );
  assertStringIncludes(
    rendered.text,
    'with recursive "thread" ("id", "depth")',
  );
  assertStringIncludes(rendered.text, "union all");
  assertStringIncludes(rendered.text, '"thread"."depth" < $2');
  // MySQL renders the same shape with backticks (supported at 8+ floors).
  assertStringIncludes(
    renderSql(
      db.with(tree).select({ id: tree.id }).from(tree).toSql(),
      { dialect: "mysql" },
    ).text,
    "with recursive `thread` (`id`, `depth`)",
  );
});

Deno.test("recursive CTE: one RECURSIVE keyword covers mixed lists", () => {
  const roots = db.$with("roots").as(
    db.select({ id: c.id }).from(comments).where(eq(c.parentId, 0)),
  );
  const tree = db.$withRecursive("tree", ["id"]).as((self) =>
    db.select({ id: c.id }).from(comments)
      .unionAll(
        db.select({ id: c.id }).from(comments)
          .innerJoin(comments, eq(c.parentId, self.id)),
      )
  );
  const text = renderSql(
    db.with(roots, tree).select({ id: tree.id }).from(tree).toSql(),
    { dialect: "postgres" },
  ).text;
  assertStringIncludes(text, 'with recursive "roots" as (');
  assertStringIncludes(text, '"tree" ("id") as (');
});

Deno.test("recursive CTE: requires an explicit column list", () => {
  const error = assertThrows(
    () => db.$withRecursive("bad", []),
    OrmError,
    "column list",
  );
  assertEquals((error as OrmError).code, "ORM_INVALID_QUERY");
});
