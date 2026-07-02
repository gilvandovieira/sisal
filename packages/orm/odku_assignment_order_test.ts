/**
 * ODKU assignment-order safety (v0.8 item 19). MySQL/MariaDB evaluate
 * `ON DUPLICATE KEY UPDATE` assignments left-to-right, so an assignment that
 * reads a sibling column set *earlier* sees its updated value — while
 * PostgreSQL reads the pre-update row uniformly. The render:
 *
 * - preserves the author's assignment order verbatim on every dialect (so the
 *   author controls the MySQL left-to-right evaluation),
 * - throws a typed guard under `mysql` when an assignment reads a sibling set
 *   earlier (the silent-divergence footgun),
 * - lets self-references, forward references (derived column first), and
 *   `excluded()` (the proposed row) through.
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  columns,
  createDatabase,
  defineTable,
  excluded,
  greatest,
  OrmError,
  renderSql,
  sql,
} from "./mod.ts";

const db = createDatabase({ dialect: "postgres" });

const buckets = defineTable("buckets", {
  id: columns.integer().primaryKey(),
  upvotes: columns.integer().notNull(),
  comments: columns.integer().notNull(),
  score: columns.doublePrecision().notNull(),
});
const b = buckets.columns;

Deno.test("odku: assignment order is preserved verbatim per dialect", () => {
  const q = db.insert(buckets).values({
    id: 1,
    upvotes: 0,
    comments: 0,
    score: 0,
  })
    .onConflictDoUpdate({
      target: b.id,
      set: {
        score: sql`${b.upvotes} * 1.0`,
        upvotes: sql`${b.upvotes} + 1`,
      },
    });
  // pg: score first, then upvotes — the author's order.
  assertEquals(
    renderSql(q.toSql(), { dialect: "postgres" }).text.includes(
      'set "score" = "buckets"."upvotes" * 1.0, ' +
        '"upvotes" = "buckets"."upvotes" + 1',
    ),
    true,
    renderSql(q.toSql(), { dialect: "postgres" }).text,
  );
});

Deno.test("odku: derived-first (forward reference) is allowed on mysql", () => {
  // score reads upvotes, which is set LATER -> reads the OLD value on MySQL
  // too, matching PostgreSQL. Renders on every dialect.
  const q = db.insert(buckets).values({
    id: 1,
    upvotes: 0,
    comments: 0,
    score: 0,
  })
    .onConflictDoUpdate({
      target: b.id,
      set: {
        score: sql`(${b.upvotes} + 1) * 2.0`,
        upvotes: sql`${b.upvotes} + 1`,
        comments: sql`${b.comments} + 1`,
      },
    });
  assert(
    renderSql(q.toSql(), { dialect: "mysql" }).text.includes(
      "on duplicate key update",
    ),
  );
});

Deno.test("odku: self-reference (col = col + 1) is allowed on mysql", () => {
  const q = db.insert(buckets).values({
    id: 1,
    upvotes: 0,
    comments: 0,
    score: 0,
  })
    .onConflictDoUpdate({
      target: b.id,
      set: {
        upvotes: sql`${b.upvotes} + 1`,
        comments: sql`${b.comments} + 1`,
      },
    });
  assert(
    renderSql(q.toSql(), { dialect: "mysql" }).text.includes(
      "on duplicate key update",
    ),
  );
});

Deno.test("odku: excluded() (proposed row) is allowed on mysql", () => {
  const q = db.insert(buckets).values({
    id: 1,
    upvotes: 0,
    comments: 0,
    score: 0,
  })
    .onConflictDoUpdate({
      target: b.id,
      set: {
        upvotes: excluded(b.upvotes),
        score: sql`${excluded(b.upvotes)} * 2.0`,
      },
    });
  // score reads excluded(upvotes) — the proposed row, not the earlier bare
  // assignment — so it is safe even though `upvotes` is set earlier.
  assert(
    renderSql(q.toSql(), { dialect: "mysql" }).text.includes(
      "on duplicate key update",
    ),
  );
});

Deno.test("odku: backward reference throws typed under mysql, renders on pg", () => {
  // score reads upvotes, which is set EARLIER -> on MySQL score would read the
  // already-incremented value (diverging from PostgreSQL). The footgun.
  const q = db.insert(buckets).values({
    id: 1,
    upvotes: 0,
    comments: 0,
    score: 0,
  })
    .onConflictDoUpdate({
      target: b.id,
      set: {
        upvotes: sql`${b.upvotes} + 1`,
        score: sql`${b.upvotes} * 2.0`,
      },
    });
  // PostgreSQL renders it (order-independent there).
  assert(
    renderSql(q.toSql(), { dialect: "postgres" }).text.includes(
      "do update set",
    ),
  );
  // MySQL throws a typed guard naming the columns.
  const error = assertThrows(
    () => renderSql(q.toSql(), { dialect: "mysql" }),
    OrmError,
    "left-to-right",
  );
  assertEquals((error as OrmError).code, "ORM_DIALECT_UNSUPPORTED");
  assert((error as OrmError).message.includes('"score"'), error.message);
  assert((error as OrmError).message.includes('"upvotes"'), error.message);
  // MariaDB (the mysql render dialect) is guarded the same way.
  assertThrows(
    () => renderSql(q.toSql(), { dialect: "mysql", variant: "mariadb" }),
    OrmError,
    "left-to-right",
  );
});

Deno.test("odku: backward reference inside dialect helper throws", () => {
  // greatest() renders through a dialect chunk; the scanner still needs to see
  // the inner buckets.upvotes reference, because MySQL would read the updated
  // value after the earlier assignment.
  const q = db.insert(buckets).values({
    id: 1,
    upvotes: 0,
    comments: 0,
    score: 0,
  })
    .onConflictDoUpdate({
      target: b.id,
      set: {
        upvotes: sql`${b.upvotes} + 1`,
        score: greatest<number>(b.upvotes, 0),
      },
    });
  const error = assertThrows(
    () => renderSql(q.toSql(), { dialect: "mysql" }),
    OrmError,
    "left-to-right",
  );
  assertEquals(error.code, "ORM_DIALECT_UNSUPPORTED");
  assert(error.message.includes('"score"'), error.message);
  assert(error.message.includes('"upvotes"'), error.message);
});

Deno.test("odku: a bare foreign expression does not reference siblings", () => {
  const other = defineTable("other", { n: columns.integer().notNull() })
    .columns;
  // score reads other.n (a different table), never a sibling of the SET — safe.
  const q = db.insert(buckets).values({
    id: 1,
    upvotes: 0,
    comments: 0,
    score: 0,
  })
    .onConflictDoUpdate({
      target: b.id,
      set: {
        upvotes: sql`${b.upvotes} + 1`,
        score: sql`${other.n} * 2.0`,
      },
    });
  assert(
    renderSql(q.toSql(), { dialect: "mysql" }).text.includes(
      "on duplicate key update",
    ),
  );
});
