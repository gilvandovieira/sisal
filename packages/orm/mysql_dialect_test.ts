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
 *   to `values(col)` (the one spelling MySQL 5.7→9.x and MariaDB share).
 * - **Typed guards (C3 + the guard sweep):** `RETURNING` (MySQL has none;
 *   MariaDB's is per-statement and per-version), `UPDATE … FROM`,
 *   `DELETE … USING`, data-modifying CTEs, `distinctOn`, and the array
 *   operators all throw `ORM_DIALECT_UNSUPPORTED` under `mysql` instead of
 *   rendering SQL the engine rejects.
 * - **Remaining pinned gap:** the portable date helpers throw (no `mysql`
 *   variants yet — v0.7 adapter work). Changing any behavior here fails the
 *   matching test and must move `docs/v0.6.0-roadmap.md` (workstream C).
 *
 * @module
 */
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  arrayContains,
  columns,
  count,
  createDatabase,
  dateBin,
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
} from "./mod.ts";

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
// unguarded: distinctOn, array operators, data-modifying CTEs, DELETE … USING,
// and UPDATE … FROM.

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
  // UPDATE … FROM: MySQL's equivalent is the multi-table UPDATE — guarded
  // until v0.7 maps that shape.
  const scores = db.$with("scores").as(
    db.select({ id: posts.columns.id }).from(posts),
  );
  assertThrows(
    () =>
      renderSql(
        db.with(scores).update(posts).set({ score: 0 })
          .from(scores).where(eq(posts.columns.id, scores.id)).toSql(),
        { dialect: "mysql" },
      ),
    OrmError,
    "UPDATE",
  );
  // DELETE … USING: MySQL's multi-table form needs the target repeated in
  // USING — guarded until v0.7 maps it.
  assertThrows(
    () =>
      renderSql(
        db.with(scores).delete(posts).using(scores)
          .where(eq(posts.columns.id, scores.id)).toSql(),
        { dialect: "mysql" },
      ),
    OrmError,
    "DELETE",
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

Deno.test("mysql gap (pinned): filter() throws (no FILTER clause)", () => {
  // Neither MySQL nor MariaDB supports FILTER (WHERE …) — C5 probe. The CASE
  // WHEN fallback rendering is v0.7 core work; until then a typed throw.
  const q = db.select({
    n: filter(count(), eq(posts.columns.title, "x")),
  }).from(posts);
  const error = assertThrows(
    () => renderSql(q.toSql(), { dialect: "mysql" }),
    OrmError,
    "filter",
  );
  assertEquals((error as OrmError).code, "ORM_DIALECT_UNSUPPORTED");
  // Native rendering is unchanged on the shipped dialects.
  assertStringIncludes(
    renderSql(q.toSql(), { dialect: "postgres" }).text,
    "filter (where",
  );
  assertStringIncludes(
    renderSql(q.toSql(), { dialect: "sqlite" }).text,
    "filter (where",
  );
});

Deno.test("mysql gap (pinned): portable date helpers throw", () => {
  // dateTrunc/now/dateBin carry only postgres + sqlite variants; under "mysql"
  // they throw ORM_DIALECT_UNSUPPORTED until the mysql variants exist.
  const q = db.select({ bucket: dateTrunc("hour", posts.columns.score) })
    .from(posts);
  const error = assertThrows(
    () => renderSql(q.toSql(), { dialect: "mysql" }),
    OrmError,
    "dateTrunc",
  );
  assertEquals((error as OrmError).code, "ORM_DIALECT_UNSUPPORTED");
  assertThrows(
    () => renderSql(now(), { dialect: "mysql" }),
    OrmError,
    "now",
  );
  assertThrows(
    () =>
      renderSql(dateBin({ minutes: 5 }, posts.columns.score), {
        dialect: "mysql",
      }),
    OrmError,
    "dateBin",
  );
});
