/**
 * Assembly/builder equivalence — the drift-killer behind the v0.8 item-5
 * seam: the same statement built through the fluent ORM builder and through
 * `@sisal/core`'s `assembleSelect`/`assembleInsertFromSelect` renders
 * **byte-identical text and parameters on every dialect**. If either side's
 * rendering changes, this fails before any downstream package notices.
 */
import { assertEquals } from "@std/assert";
import {
  and,
  asc,
  assembleInsertFromSelect,
  assembleSelect,
  columns,
  count,
  createDatabase,
  dateTrunc,
  defineTable,
  eq,
  excluded,
  filter,
  gt,
  gte,
  lt,
  primaryKey,
  renderSql,
  sql,
} from "../mod.ts";
import type { Sql, SqlDialect } from "../mod.ts";

const db = createDatabase({ dialect: "postgres" });

const postEvents = defineTable("post_events", {
  id: columns.bigserial().primaryKey(),
  post_id: columns.bigint().notNull(),
  kind: columns.text().notNull(),
  occurred_at: columns.timestamp({ withTimezone: true, mode: "date" })
    .notNull(),
});

const postHourlyStats = defineTable("post_hourly_stats", {
  post_id: columns.bigint().notNull(),
  bucket: columns.timestamp({ withTimezone: true, mode: "date" }).notNull(),
  views: columns.integer().notNull(),
  votes: columns.integer().notNull(),
  comments: columns.integer().notNull(),
  engagement_score: columns.doublePrecision().notNull(),
}, (c) => [primaryKey({ columns: [c.post_id, c.bucket] })]);

const FROM = new Date("2026-01-01T00:00:00Z");
const UNTIL = new Date("2026-01-02T00:00:00Z");

// `generic` is excluded: both statements carry `dateTrunc`, which throws its
// typed guard there on both sides identically (pinned by the goldens).
const DIALECTS: readonly SqlDialect[] = ["postgres", "sqlite", "mysql"];

function assertSameRender(builder: Sql, assembled: Sql) {
  for (const dialect of DIALECTS) {
    const a = renderSql(builder, { dialect });
    const b = renderSql(assembled, { dialect });
    assertEquals(b.text, a.text, dialect);
    assertEquals(b.params, a.params, dialect);
  }
}

Deno.test("equivalence: grouped filtered select", () => {
  const e = postEvents.columns;
  const bucket = dateTrunc("hour", e.occurred_at);
  const projection = {
    post_id: e.post_id,
    bucket,
    views: filter(count(), eq(e.kind, "view")),
  };
  const where = and(gte(e.occurred_at, FROM), lt(e.occurred_at, UNTIL));

  const builder = db.select(projection).from(postEvents)
    .where(where).groupBy(e.post_id, bucket)
    .having(gt(count(), 1)).orderBy(asc(e.post_id)).limit(50).toSql();
  const assembled = assembleSelect({
    select: projection,
    from: postEvents,
    where,
    groupBy: [e.post_id, bucket],
    having: gt(count(), 1),
    orderBy: [asc(e.post_id)],
    limit: 50,
  });
  assertSameRender(builder, assembled);
});

Deno.test("equivalence: the full rollup insert-from-select + upsert", () => {
  const e = postEvents.columns;
  const s = postHourlyStats.columns;
  const bucket = dateTrunc("hour", e.occurred_at);
  const projection = {
    post_id: e.post_id,
    bucket,
    views: filter(count(), eq(e.kind, "view")),
    votes: filter(count(), eq(e.kind, "vote")),
    comments: filter(count(), eq(e.kind, "comment")),
    engagement_score: sql`${filter(count(), eq(e.kind, "vote"))} * 2.0 + ${
      filter(count(), eq(e.kind, "comment"))
    } * 3.0`,
  };
  const where = and(gte(e.occurred_at, FROM), lt(e.occurred_at, UNTIL));
  const set = {
    views: excluded(s.views),
    votes: excluded(s.votes),
    comments: excluded(s.comments),
    engagement_score: excluded(s.engagement_score),
  };

  const builder = db.insert(postHourlyStats).select(
    db.select(projection).from(postEvents)
      .where(where).groupBy(e.post_id, bucket),
  ).onConflictDoUpdate({ target: [s.post_id, s.bucket], set }).toSql();
  const assembled = assembleInsertFromSelect({
    into: postHourlyStats,
    select: {
      select: projection,
      from: postEvents,
      where,
      groupBy: [e.post_id, bucket],
    },
    onConflictDoUpdate: { target: [s.post_id, s.bucket], set },
  });
  assertSameRender(builder, assembled);
});
