/**
 * ETL rollup composition (v0.6.0 workstream A, task A1): the v0.5 pieces —
 * `insert().select()`, `filter()` FILTER aggregates, `dateTrunc` buckets,
 * `groupBy`, and `onConflictDoUpdate` — compose into the canonical
 * `post_events → post_hourly_stats` rollup as ONE builder statement, pinned
 * per dialect. This is the roadmap's "upsert-from-select: verify they compose"
 * cell; a change to any clause's rendering or to cross-clause parameter order
 * fails here and must move `docs/v0.6.0-roadmap.md` in step.
 *
 * @module
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  and,
  columns,
  count,
  countDistinct,
  createDatabase,
  dateTrunc,
  defineTable,
  eq,
  excluded,
  filter,
  gte,
  lt,
  primaryKey,
  renderSql,
  type Sql,
  sql,
  sum,
} from "./mod.ts";

const db = createDatabase({ dialect: "postgres" });

const postEvents = defineTable("post_events", {
  id: columns.bigserial().primaryKey(),
  post_id: columns.bigint().notNull(),
  actor_id: columns.bigint().notNull(),
  kind: columns.text().notNull(),
  value: columns.integer().notNull().default(1),
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

/** The canonical rollup from the v0.6 roadmap, as one builder statement. */
function rollup(): { toSql(): Sql } {
  const e = postEvents.columns;
  const s = postHourlyStats.columns;
  // One fragment instance, reused by the projection AND the GROUP BY.
  const bucket = dateTrunc("hour", e.occurred_at);
  return db.insert(postHourlyStats).select(
    db.select({
      post_id: e.post_id,
      bucket,
      views: filter(count(), eq(e.kind, "view")),
      votes: filter(count(), eq(e.kind, "vote")),
      comments: filter(count(), eq(e.kind, "comment")),
      // A weighted metric composed from typed FILTER fragments.
      engagement_score: sql`${filter(count(), eq(e.kind, "vote"))} * 2.0 + ${
        filter(count(), eq(e.kind, "comment"))
      } * 3.0`,
    }).from(postEvents)
      .where(and(gte(e.occurred_at, FROM), lt(e.occurred_at, UNTIL)))
      .groupBy(e.post_id, bucket),
  ).onConflictDoUpdate({
    target: [s.post_id, s.bucket],
    set: {
      views: excluded(s.views),
      votes: excluded(s.votes),
      comments: excluded(s.comments),
      engagement_score: excluded(s.engagement_score),
    },
  });
}

Deno.test("etl rollup: the full statement renders on postgres", () => {
  const rendered = renderSql(rollup().toSql(), { dialect: "postgres" });
  assertEquals(
    rendered.text,
    'insert into "post_hourly_stats" ' +
      '("post_id", "bucket", "views", "votes", "comments", ' +
      '"engagement_score") ' +
      'select "post_events"."post_id" as "post_id", ' +
      `date_trunc('hour', "post_events"."occurred_at") as "bucket", ` +
      'count(*) filter (where "post_events"."kind" = $1) as "views", ' +
      'count(*) filter (where "post_events"."kind" = $2) as "votes", ' +
      'count(*) filter (where "post_events"."kind" = $3) as "comments", ' +
      'count(*) filter (where "post_events"."kind" = $4) * 2.0 + ' +
      'count(*) filter (where "post_events"."kind" = $5) * 3.0 ' +
      'as "engagement_score" ' +
      'from "post_events" ' +
      'where ("post_events"."occurred_at" >= $6) ' +
      'and ("post_events"."occurred_at" < $7) ' +
      'group by "post_events"."post_id", ' +
      `date_trunc('hour', "post_events"."occurred_at") ` +
      'on conflict ("post_id", "bucket") do update set ' +
      '"views" = excluded."views", "votes" = excluded."votes", ' +
      '"comments" = excluded."comments", ' +
      '"engagement_score" = excluded."engagement_score"',
  );
  // Cross-clause parameter order: projection filters first, then the window.
  assertEquals(rendered.params, [
    "view",
    "vote",
    "comment",
    "vote",
    "comment",
    FROM,
    UNTIL,
  ]);
});

Deno.test("etl rollup: the full statement renders on the sqlite family", () => {
  const rendered = renderSql(rollup().toSql(), { dialect: "sqlite" });
  assertEquals(
    rendered.text,
    'insert into "post_hourly_stats" ' +
      '("post_id", "bucket", "views", "votes", "comments", ' +
      '"engagement_score") ' +
      'select "post_events"."post_id" as "post_id", ' +
      `strftime('%Y-%m-%d %H:00:00', "post_events"."occurred_at") ` +
      'as "bucket", ' +
      'count(*) filter (where "post_events"."kind" = ?) as "views", ' +
      'count(*) filter (where "post_events"."kind" = ?) as "votes", ' +
      'count(*) filter (where "post_events"."kind" = ?) as "comments", ' +
      'count(*) filter (where "post_events"."kind" = ?) * 2.0 + ' +
      'count(*) filter (where "post_events"."kind" = ?) * 3.0 ' +
      'as "engagement_score" ' +
      'from "post_events" ' +
      'where ("post_events"."occurred_at" >= ?) ' +
      'and ("post_events"."occurred_at" < ?) ' +
      'group by "post_events"."post_id", ' +
      `strftime('%Y-%m-%d %H:00:00', "post_events"."occurred_at") ` +
      'on conflict ("post_id", "bucket") do update set ' +
      '"views" = excluded."views", "votes" = excluded."votes", ' +
      '"comments" = excluded."comments", ' +
      '"engagement_score" = excluded."engagement_score"',
  );
  assertEquals(rendered.params, [
    "view",
    "vote",
    "comment",
    "vote",
    "comment",
    FROM,
    UNTIL,
  ]);
});

Deno.test("etl rollup: coalesced sum FILTER + countDistinct fold shape", () => {
  // The activity-vectors example's fold: NOT NULL counter columns need the
  // NULL-when-no-match FILTER sum wrapped in coalesce (via the sql tag — there
  // is no typed coalesce helper), and distinct actors via countDistinct.
  const e = postEvents.columns;
  const q = db.select({
    post_id: e.post_id,
    votes: sql`coalesce(${filter(sum(e.value), eq(e.kind, "vote"))}, 0)`,
    actors: countDistinct(e.actor_id),
  }).from(postEvents).groupBy(e.post_id);
  const rendered = renderSql(q.toSql(), { dialect: "postgres" });
  assertStringIncludes(
    rendered.text,
    'coalesce(sum("post_events"."value") filter ' +
      '(where "post_events"."kind" = $1), 0) as "votes"',
  );
  assertStringIncludes(
    rendered.text,
    'count(distinct "post_events"."actor_id") as "actors"',
  );
});
