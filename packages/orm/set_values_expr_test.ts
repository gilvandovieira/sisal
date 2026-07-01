/**
 * Tests for raw `sql` expressions as values in `.set()` / `.values()` /
 * `onConflictDoUpdate.set` (roadmap item 4): expressions render inline while
 * literal values still bind as parameters.
 */
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  columns,
  createDatabase,
  defineTable,
  eq,
  excluded,
  OrmError,
  renderSql,
  type Sql,
  sql,
} from "./mod.ts";

const db = createDatabase({ dialect: "postgres" });

const posts = defineTable("posts", {
  id: columns.uuid().primaryKey(),
  title: columns.text().notNull(),
  score: columns.integer().notNull(),
  upvotes: columns.integer().notNull(),
  downvotes: columns.integer().notNull(),
});

function render(query: { toSql(): Sql }) {
  return renderSql(query.toSql(), { dialect: "postgres" });
}

Deno.test("set/values: UPDATE set mixes a sql expression and a literal", () => {
  const rendered = render(
    db.update(posts).set({
      score: sql`${posts.columns.upvotes} - ${posts.columns.downvotes}`,
      title: "renamed",
    }).where(eq(posts.columns.id, "p1")),
  );
  assertEquals(
    rendered.text,
    'update "posts" set "score" = "posts"."upvotes" - "posts"."downvotes", ' +
      '"title" = $1 where "posts"."id" = $2',
  );
  // Only the literals bind; the expression renders inline.
  assertEquals(rendered.params, ["renamed", "p1"]);
});

Deno.test("set/values: INSERT values mixes a sql expression and literals", () => {
  const rendered = render(
    db.insert(posts).values({
      id: "p1",
      title: "hello",
      score: sql`abs(-5)`,
      upvotes: 1,
      downvotes: 0,
    }),
  );
  assertEquals(
    rendered.text,
    'insert into "posts" ("id", "title", "score", "upvotes", "downvotes") ' +
      "values ($1, $2, abs(-5), $3, $4)",
  );
  assertEquals(rendered.params, ["p1", "hello", 1, 0]);
});

Deno.test("set/values: onConflictDoUpdate set accepts a sql expression", () => {
  const rendered = render(
    db.insert(posts).values({
      id: "p1",
      title: "x",
      score: 1,
      upvotes: 1,
      downvotes: 0,
    }).onConflictDoUpdate({
      target: posts.columns.id,
      set: { score: sql`excluded.score + 1` },
    }),
  );
  assertStringIncludes(
    rendered.text,
    'on conflict ("id") do update set "score" = excluded.score + 1',
  );
});

Deno.test("set/values: excluded() maps the property key to the physical column", () => {
  // Under the default snake_case naming strategy `hotScore` → `hot_score`.
  // A raw sql`excluded.hotScore` would silently name a nonexistent column;
  // the typed helper resolves the physical name (and quotes it).
  const feed = defineTable("feed", {
    id: columns.uuid().primaryKey(),
    hotScore: columns.integer().notNull(),
  });
  const rendered = render(
    db.insert(feed).values({ id: "p1", hotScore: 1 }).onConflictDoUpdate({
      target: feed.columns.id,
      set: { hotScore: excluded(feed.columns.hotScore) },
    }),
  );
  assertStringIncludes(
    rendered.text,
    'on conflict ("id") do update set "hot_score" = excluded."hot_score"',
  );
});

Deno.test("set/values: excluded() rejects a non-column argument", () => {
  assertThrows(() => excluded("hot_score"), OrmError, "column");
  assertThrows(() => excluded(sql`hot_score`), OrmError, "column");
});

Deno.test("set/values: a pure-expression UPDATE binds no value params", () => {
  const rendered = render(
    db.update(posts).set({
      score: sql`${posts.columns.upvotes} - ${posts.columns.downvotes}`,
    }).where(eq(posts.columns.id, "p1")),
  );
  // The only bound parameter is the where-clause id.
  assertEquals(rendered.params, ["p1"]);
});
