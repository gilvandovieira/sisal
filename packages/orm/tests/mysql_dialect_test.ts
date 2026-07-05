/**
 * The latent `"mysql"` dialect, pinned (v0.6.0 workstream C, task C1). No
 * `@sisal/mysql` adapter exists — v0.7 builds it — but the renderer already
 * half-knows MySQL. These tests pin BOTH sides of that, the way
 * `docs/drizzle-parity.md` pins unbuilt Drizzle features:
 *
 * - **Render-ready:** backtick identifier quoting, `?` placeholders,
 *   `ilike`→`LIKE`, plain SELECT/INSERT, `FOR UPDATE` row locking, and — since
 *   C2 — the dialect-mapped upsert: `onConflictDoUpdate`/`onConflictDoNothing`
 *   render `ON DUPLICATE KEY UPDATE` under `mysql`, with `excluded()` mapping
 *   to `values(col)` (the one spelling MySQL 5.7→9.x and MariaDB share), and
 *   — since B10 — multi-table mutation joins (`UPDATE t, s SET …` and
 *   `DELETE FROM t USING t, s …`).
 * - **Typed guards (C3 + the guard sweep):** `RETURNING` (MySQL has none;
 *   MariaDB's is per-statement and per-version), data-modifying CTEs,
 *   `distinctOn`, and the array operators all throw `ORM_DIALECT_UNSUPPORTED`
 *   under `mysql` instead of rendering SQL the engine rejects.
 * - **B2 renderings:** `filter()` rebuilds the exported aggregates as
 *   `agg(CASE WHEN … END)` (hand-written aggregates still throw — no
 *   metadata to rebuild from), and the date helpers render their mysql
 *   variants (`DATE_FORMAT`/`NOW(6)`/nested `DATE_ADD`/`FROM_UNIXTIME`) —
 *   all verified live on MySQL 8.4.10 + MariaDB 11.8.8. Changing any
 *   behavior here fails the matching test and must move the v0.6/v0.7
 *   roadmaps in step.
 *
 * @module
 */
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  arrayContains,
  columns,
  count,
  countDistinct,
  createDatabase,
  dateAdd,
  dateBin,
  dateSub,
  dateTrunc,
  defineTable,
  eq,
  excluded,
  filter,
  gt,
  ilike,
  notIlike,
  now,
  OrmError,
  quoteIdentifier,
  renderSql,
  sql,
  sum,
} from "../mod.ts";

const db = createDatabase({ dialect: "postgres" });

const posts = defineTable("posts", {
  id: columns.integer().primaryKey(),
  title: columns.text().notNull(),
  score: columns.integer().notNull().default(0),
});

Deno.test("mysql: backtick identifier quoting + ? placeholders", () => {
  assertEquals(quoteIdentifier("posts.id", "mysql"), "`posts`.`id`");

  const q = db.select({ id: posts.columns.id, title: posts.columns.title })
    .from(posts).where(eq(posts.columns.title, "hello"));
  const rendered = renderSql(q.toSql(), { dialect: "mysql" });
  assertEquals(
    rendered.text,
    "select `posts`.`id` as `id`, `posts`.`title` as `title` " +
      "from `posts` where `posts`.`title` = ?",
  );
  assertEquals(rendered.params, ["hello"]);
});

Deno.test("mysql: plain INSERT renders with backticks and ?", () => {
  const q = db.insert(posts).values({ id: 1, title: "a", score: 2 });
  const rendered = renderSql(q.toSql(), { dialect: "mysql" });
  assertEquals(
    rendered.text,
    "insert into `posts` (`id`, `title`, `score`) values (?, ?, ?)",
  );
  assertEquals(rendered.params, [1, "a", 2]);
});

Deno.test("mysql: ilike / notIlike degrade to LIKE / NOT LIKE", () => {
  const q = db.select().from(posts).where(ilike(posts.columns.title, "a%"));
  assertStringIncludes(
    renderSql(q.toSql(), { dialect: "mysql" }).text,
    "where `posts`.`title` like ?",
  );
  const n = db.select().from(posts).where(notIlike(posts.columns.title, "a%"));
  assertStringIncludes(
    renderSql(n.toSql(), { dialect: "mysql" }).text,
    "where `posts`.`title` not like ?",
  );
});

Deno.test("mysql: FOR UPDATE row locking renders (MySQL supports it)", () => {
  assertStringIncludes(
    renderSql(db.select().from(posts).for("update").toSql(), {
      dialect: "mysql",
    }).text,
    "for update",
  );
});

// ---- C2: the dialect-mapped upsert ------------------------------------------
// One `onConflict*` call renders `ON CONFLICT` on Postgres/SQLite and
// `ON DUPLICATE KEY UPDATE` on MySQL. The conflict target is validated but not
// rendered under mysql (ODKU fires on ANY unique-key violation); a conflict
// `where` has no MySQL equivalent and throws a typed error.

Deno.test("mysql C2: onConflictDoUpdate renders ON DUPLICATE KEY UPDATE", () => {
  const q = db.insert(posts).values({ id: 1, title: "a" }).onConflictDoUpdate({
    target: posts.columns.id,
    set: {
      title: excluded(posts.columns.title),
      score: sql`${excluded(posts.columns.score)} + 1`,
    },
  });
  // mysql: no target, excluded() → values(col).
  assertStringIncludes(
    renderSql(q.toSql(), { dialect: "mysql" }).text,
    "on duplicate key update `title` = values(`title`), " +
      "`score` = values(`score`) + 1",
  );
  // The same builder still renders the Postgres/SQLite form untouched.
  assertStringIncludes(
    renderSql(q.toSql(), { dialect: "postgres" }).text,
    'on conflict ("id") do update set "title" = excluded."title", ' +
      '"score" = excluded."score" + 1',
  );
});

Deno.test("mysql C2: onConflictDoNothing renders a no-op assignment", () => {
  // MySQL has no DO NOTHING; the standard idiom is a self-assignment (`INSERT
  // IGNORE` is not equivalent — it swallows unrelated errors).
  const targeted = db.insert(posts).values({ id: 1, title: "a" })
    .onConflictDoNothing({ target: posts.columns.title });
  assertStringIncludes(
    renderSql(targeted.toSql(), { dialect: "mysql" }).text,
    "on duplicate key update `title` = `title`",
  );
  // Without a target the table's primary-key column is the no-op.
  const bare = db.insert(posts).values({ id: 1, title: "a" })
    .onConflictDoNothing();
  assertStringIncludes(
    renderSql(bare.toSql(), { dialect: "mysql" }).text,
    "on duplicate key update `id` = `id`",
  );
  // Postgres/SQLite rendering is unchanged.
  assertStringIncludes(
    renderSql(bare.toSql(), { dialect: "postgres" }).text,
    "on conflict do nothing",
  );
});

Deno.test("mysql C2: a conflict `where` throws a typed error", () => {
  const q = db.insert(posts).values({ id: 1, title: "a" }).onConflictDoUpdate({
    target: posts.columns.id,
    set: { score: sql`${excluded(posts.columns.score)}` },
    where: gt(posts.columns.score, 0),
  });
  // Postgres renders the conditional upsert; MySQL has no equivalent.
  assertStringIncludes(
    renderSql(q.toSql(), { dialect: "postgres" }).text,
    "do update set",
  );
  const error = assertThrows(
    () => renderSql(q.toSql(), { dialect: "mysql" }),
    OrmError,
    "where",
  );
  assertEquals((error as OrmError).code, "ORM_DIALECT_UNSUPPORTED");
});

// ---- C3: RETURNING + the dialect-guard sweep --------------------------------
// MySQL has no RETURNING on any mutation, and MariaDB's is per-statement AND
// per-version (DELETE 10.0.5+, INSERT/REPLACE 10.5+, UPDATE only 13.0+), so
// the version-less "mysql" dialect throws a typed guard instead of rendering
// SQL the engine rejects. The same sweep corrected the guards C1 pinned as
// unguarded: distinctOn, array operators, and data-modifying CTEs. B10 below
// lifts the former UPDATE … FROM / DELETE … USING guards with MySQL's
// multi-table statement shapes.

Deno.test("mysql C3: RETURNING throws a typed error on every mutation", () => {
  const inserted = db.insert(posts).values({ id: 1, title: "a" }).returning();
  const updated = db.update(posts).set({ score: 1 })
    .where(eq(posts.columns.id, 1)).returning({ id: posts.columns.id });
  const deleted = db.delete(posts).where(eq(posts.columns.id, 1)).returning();
  for (const q of [inserted, updated, deleted]) {
    const error = assertThrows(
      () => renderSql(q.toSql(), { dialect: "mysql" }),
      OrmError,
      "RETURNING",
    );
    assertEquals((error as OrmError).code, "ORM_DIALECT_UNSUPPORTED");
    // Postgres AND SQLite both support RETURNING — rendering is unchanged.
    assertStringIncludes(
      renderSql(q.toSql(), { dialect: "postgres" }).text,
      "returning",
    );
    assertStringIncludes(
      renderSql(q.toSql(), { dialect: "sqlite" }).text,
      "returning",
    );
  }
});

Deno.test("mysql C3: guard sweep — unsupported constructs throw", () => {
  // distinctOn (was pinned unguarded by C1 — now corrected).
  assertThrows(
    () =>
      renderSql(
        db.select().from(posts).distinctOn(posts.columns.title).toSql(),
        { dialect: "mysql" },
      ),
    OrmError,
    "distinctOn",
  );
  // Data-modifying CTEs: MySQL/MariaDB WITH is SELECT-only.
  const moved = db.$with("moved").as(
    db.delete(posts).where(eq(posts.columns.id, 1))
      .returning({ id: posts.columns.id }),
  );
  assertThrows(
    () =>
      renderSql(
        db.with(moved).select({ id: moved.id }).from(moved).toSql(),
        { dialect: "mysql" },
      ),
    OrmError,
    "data-modifying",
  );
  // FULL JOIN: neither MySQL nor MariaDB has FULL OUTER JOIN (C5 probe);
  // rightJoin renders fine on both.
  const other = defineTable("other", {
    id: columns.integer().primaryKey(),
  });
  assertThrows(
    () =>
      renderSql(
        db.select({ id: posts.columns.id }).from(posts)
          .fullJoin(other, eq(posts.columns.id, other.columns.id)).toSql(),
        { dialect: "mysql" },
      ),
    OrmError,
    "FULL JOIN",
  );
  assertStringIncludes(
    renderSql(
      db.select({ id: posts.columns.id }).from(posts)
        .rightJoin(other, eq(posts.columns.id, other.columns.id)).toSql(),
      { dialect: "mysql" },
    ).text,
    "right join `other`",
  );
  // Array operators: no array type in MySQL.
  assertThrows(
    () =>
      renderSql(
        db.select().from(posts)
          .where(arrayContains(posts.columns.title, ["a"])).toSql(),
        { dialect: "mysql" },
      ),
    OrmError,
    "arrayContains",
  );
});

// ---- B10: mysql multi-table UPDATE / DELETE mappings ------------------------
// Existing portable builders keep their API; the mysql dialect rewrites the
// statement shape to the family-native multi-table forms.

Deno.test("mysql B10: update().from() renders multi-table UPDATE", () => {
  const scores = db.$with("scores").as(
    db.select({ id: posts.columns.id }).from(posts),
  );
  const query = db.with(scores).update(posts).set({ score: 0 })
    .from(scores).where(eq(posts.columns.id, scores.id));

  const mysql = renderSql(query.toSql(), { dialect: "mysql" });
  assertEquals(
    mysql.text,
    "with `scores` as (select `posts`.`id` as `id` from `posts`) " +
      "update `posts`, `scores` set `posts`.`score` = ? " +
      "where `posts`.`id` = `scores`.`id`",
  );
  assertEquals(mysql.params, [0]);

  assertStringIncludes(
    renderSql(query.toSql(), { dialect: "postgres" }).text,
    'update "posts" set "score" = $1 from "scores"',
  );
  assertStringIncludes(
    renderSql(query.toSql(), { dialect: "sqlite" }).text,
    'update "posts" set "score" = ? from "scores"',
  );
});

Deno.test("mysql B10: delete().using() renders multi-table DELETE", () => {
  const scores = db.$with("scores").as(
    db.select({ id: posts.columns.id }).from(posts),
  );
  const query = db.with(scores).delete(posts).using(scores)
    .where(eq(posts.columns.id, scores.id));

  assertEquals(
    renderSql(query.toSql(), { dialect: "mysql" }).text,
    "with `scores` as (select `posts`.`id` as `id` from `posts`) " +
      "delete from `posts` using `posts`, `scores` " +
      "where `posts`.`id` = `scores`.`id`",
  );
  assertStringIncludes(
    renderSql(query.toSql(), { dialect: "postgres" }).text,
    'delete from "posts" using "scores"',
  );

  const error = assertThrows(
    () => renderSql(query.toSql(), { dialect: "sqlite" }),
    OrmError,
    "DELETE … USING",
  );
  assertEquals((error as OrmError).code, "ORM_DIALECT_UNSUPPORTED");
});

Deno.test("mysql B10: multi-table mutations keep RETURNING guarded", () => {
  // Subquery sources (no CTE) so only the RETURNING guard is in play — a
  // WITH prefix would trip its own MariaDB guard first (pinned below).
  const scores = db.select({ id: posts.columns.id }).from(posts).as("scores");
  const updated = db.update(posts).set({ score: 0 })
    .from(scores).where(eq(posts.columns.id, scores.id))
    .returning({ id: posts.columns.id });
  const deleted = db.delete(posts).using(scores)
    .where(eq(posts.columns.id, scores.id)).returning({ id: posts.columns.id });

  for (const query of [updated, deleted]) {
    const error = assertThrows(
      () =>
        renderSql(query.toSql(), {
          dialect: "mysql",
          variant: "mariadb",
          version: "13.0",
        }),
      OrmError,
      "RETURNING",
    );
    assertEquals((error as OrmError).code, "ORM_DIALECT_UNSUPPORTED");
  }
});

Deno.test("mysql: CTE-prefixed mutations throw typed under MariaDB", () => {
  // MariaDB parses a WITH prefix only on SELECT (verified live on 11.8.8);
  // MySQL 8+ accepts it on mutations too, so the guard is variant-narrowed.
  const scores = db.$with("scores").as(
    db.select({ id: posts.columns.id }).from(posts),
  );
  const mutations = [
    {
      construct: "WITH … INSERT",
      query: db.with(scores).insert(posts).select(
        db.select({
          id: posts.columns.id,
          title: posts.columns.title,
        }).from(posts).where(eq(posts.columns.id, scores.id)),
      ),
    },
    {
      construct: "WITH … UPDATE",
      query: db.with(scores).update(posts).set({ score: 0 })
        .from(scores).where(eq(posts.columns.id, scores.id)),
    },
    {
      construct: "WITH … DELETE",
      query: db.with(scores).delete(posts).using(scores)
        .where(eq(posts.columns.id, scores.id)),
    },
  ] as const;

  for (const { construct, query } of mutations) {
    // Base mysql (any version) still renders the prefix …
    assertStringIncludes(
      renderSql(query.toSql(), { dialect: "mysql" }).text,
      "with `scores` as (",
    );
    // … while a mariadb identity fails typed, not with a raw 1064.
    const error = assertThrows(
      () => renderSql(query.toSql(), { dialect: "mysql", variant: "mariadb" }),
      OrmError,
      construct,
    );
    assertEquals((error as OrmError).code, "ORM_DIALECT_UNSUPPORTED");
    // A WITH-prefixed SELECT stays fine on MariaDB.
    assertStringIncludes(
      renderSql(
        db.with(scores).select({ id: scores.id }).from(scores).toSql(),
        { dialect: "mysql", variant: "mariadb" },
      ).text,
      "with `scores` as (",
    );
  }
});

// ---- B2: the CASE WHEN filter fallback + the date-helper mysql variants -----
// Verified live on MySQL 8.4.10 and MariaDB 11.8.8 (identical rows to the
// pg/sqlite semantics) before pinning — see the v0.7 roadmap B2 detail.

Deno.test("mysql B2: filter() rebuilds aggregates as CASE WHEN", () => {
  const q = db.select({
    vote_sum: filter(sum(posts.columns.score), eq(posts.columns.title, "v")),
    vote_rows: filter(count(), eq(posts.columns.title, "v")),
    vote_vals: filter(count(posts.columns.score), eq(posts.columns.title, "v")),
    kinds: filter(
      countDistinct(posts.columns.title),
      eq(posts.columns.title, "v"),
    ),
  }).from(posts);
  assertEquals(
    renderSql(q.toSql(), { dialect: "mysql" }).text,
    "select sum(case when `posts`.`title` = ? then `posts`.`score` end) " +
      "as `vote_sum`, " +
      "count(case when `posts`.`title` = ? then 1 end) as `vote_rows`, " +
      "count(case when `posts`.`title` = ? then `posts`.`score` end) " +
      "as `vote_vals`, " +
      "count(distinct case when `posts`.`title` = ? then `posts`.`title` end) " +
      "as `kinds` from `posts`",
  );
  // Native FILTER rendering is byte-unchanged on the shipped dialects.
  assertStringIncludes(
    renderSql(q.toSql(), { dialect: "postgres" }).text,
    'sum("posts"."score") filter (where "posts"."title" = $1)',
  );
  assertStringIncludes(
    renderSql(q.toSql(), { dialect: "sqlite" }).text,
    'sum("posts"."score") filter (where "posts"."title" = ?)',
  );
});

Deno.test("mysql B2: a hand-written aggregate still throws under mysql", () => {
  // Only the exported aggregates carry the metadata the CASE WHEN rebuild
  // needs; an opaque fragment cannot be restructured (compose-only IR).
  const custom = filter(
    sql`my_agg(${posts.columns.score})` as Parameters<typeof filter>[0],
    eq(posts.columns.title, "x"),
  );
  const error = assertThrows(
    () => renderSql(custom, { dialect: "mysql" }),
    OrmError,
    "filter",
  );
  assertEquals((error as OrmError).code, "ORM_DIALECT_UNSUPPORTED");
  // …while the shipped dialects render it natively.
  assertStringIncludes(
    renderSql(custom, { dialect: "postgres" }).text,
    "my_agg",
  );
});

Deno.test("mysql B2: date helpers render their mysql variants", () => {
  // dateTrunc → DATE_FORMAT (string result, like the SQLite family; minutes
  // are %i in MySQL).
  assertEquals(
    renderSql(dateTrunc("hour", posts.columns.score), { dialect: "mysql" })
      .text,
    "date_format(`posts`.`score`, '%Y-%m-%d %H:00:00')",
  );
  assertEquals(
    renderSql(dateTrunc("minute", posts.columns.score), { dialect: "mysql" })
      .text,
    "date_format(`posts`.`score`, '%Y-%m-%d %H:%i:00')",
  );
  // now() keeps microsecond precision, matching pg's now().
  assertEquals(renderSql(now(), { dialect: "mysql" }).text, "now(6)");
  // dateAdd/dateSub → nested DATE_ADD, quantity bound, unit a fixed keyword.
  const shifted = renderSql(
    dateAdd(now(), { hours: 1, minutes: 30 }),
    { dialect: "mysql" },
  );
  assertEquals(
    shifted.text,
    "date_add(date_add(now(6), interval ? hour), interval ? minute)",
  );
  assertEquals(shifted.params, [1, 30]);
  const back = renderSql(dateSub(now(), { days: 1 }), { dialect: "mysql" });
  assertEquals(back.text, "date_add(now(6), interval ? day)");
  assertEquals(back.params, [-1]);
  // dateBin → epoch flooring with the validated bucket width inlined.
  assertEquals(
    renderSql(dateBin({ minutes: 5 }, posts.columns.score), {
      dialect: "mysql",
    }).text,
    "from_unixtime(floor(unix_timestamp(`posts`.`score`) / 300) * 300)",
  );
});
