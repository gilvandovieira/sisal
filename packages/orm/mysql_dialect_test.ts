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
 * - **Confirmed gaps, asserted as they are:** `returning` renders though MySQL
 *   8 has none (C3), `distinctOn` is unguarded, and the portable date helpers
 *   throw. Fixing any of these fails the matching test here and must move
 *   `docs/v0.6.0-roadmap.md` (workstream C) in step.
 *
 * @module
 */
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  columns,
  createDatabase,
  dateBin,
  dateTrunc,
  defineTable,
  eq,
  excluded,
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

// ---- Confirmed divergences, pinned as they render TODAY ---------------------
// These assert the CURRENT (wrong-for-MySQL) output so the C3 dialect work
// cannot land silently: designing the real MySQL rendering fails these pins.

Deno.test("mysql C3 gap (pinned): RETURNING renders (MySQL 8 has none)", () => {
  // MySQL 8 has no RETURNING (MariaDB 10.5+ does). Today the renderer emits it
  // unchanged under "mysql"; the v0.7 adapter needs a guard or a
  // fetch-by-key fallback.
  const q = db.insert(posts).values({ id: 1, title: "a" }).returning();
  assertStringIncludes(
    renderSql(q.toSql(), { dialect: "mysql" }).text,
    "returning *",
  );
});

Deno.test("mysql gap (pinned): distinctOn renders unguarded", () => {
  // `DISTINCT ON` is PostgreSQL-only and the guard lists only "sqlite", so
  // "mysql" currently renders invalid MySQL instead of throwing.
  const q = db.select().from(posts).distinctOn(posts.columns.title);
  assertStringIncludes(
    renderSql(q.toSql(), { dialect: "mysql" }).text,
    "distinct on (`posts`.`title`)",
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
