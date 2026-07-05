/**
 * The `@sisal/core`-only rollup fixture — v0.8 item 13's acceptance proof:
 * the canonical v0.6 `post_events → post_hourly_stats` rollup (grouped
 * insert-from-select + `FILTER` aggregates + `dateTrunc` bucket + upsert)
 * constructed and rendered **using only `@sisal/core` exports** — no
 * `@sisal/orm`, no fluent builder. The statement is byte-identical to the
 * ORM builder's render (pinned again cross-package by
 * `packages/orm/assembly_equivalence_test.ts`).
 */
import { assertEquals } from "@std/assert";
import {
  and,
  assembleInsertFromSelect,
  columns,
  count,
  dateTrunc,
  defineTable,
  eq,
  excluded,
  filter,
  gte,
  lt,
  primaryKey,
  renderSql,
  sql,
} from "../mod.ts";

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

/** The canonical rollup, assembled from parts — core exports only. */
function rollup() {
  const e = postEvents.columns;
  const s = postHourlyStats.columns;
  const bucket = dateTrunc("hour", e.occurred_at);
  return assembleInsertFromSelect({
    into: postHourlyStats,
    select: {
      select: {
        post_id: e.post_id,
        bucket,
        views: filter(count(), eq(e.kind, "view")),
        votes: filter(count(), eq(e.kind, "vote")),
        comments: filter(count(), eq(e.kind, "comment")),
        engagement_score: sql`${filter(count(), eq(e.kind, "vote"))} * 2.0 + ${
          filter(count(), eq(e.kind, "comment"))
        } * 3.0`,
      },
      from: postEvents,
      where: and(gte(e.occurred_at, FROM), lt(e.occurred_at, UNTIL)),
      groupBy: [e.post_id, bucket],
    },
    onConflictDoUpdate: {
      target: [s.post_id, s.bucket],
      set: {
        views: excluded(s.views),
        votes: excluded(s.votes),
        comments: excluded(s.comments),
        engagement_score: excluded(s.engagement_score),
      },
    },
  });
}

Deno.test("core-only rollup: postgres render matches the builder's pin", () => {
  const rendered = renderSql(rollup(), { dialect: "postgres" });
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

Deno.test("core-only rollup: mysql maps the upsert to ODKU", () => {
  const rendered = renderSql(rollup(), { dialect: "mysql" });
  assertEquals(
    rendered.text.includes(
      "on duplicate key update `views` = values(`views`), " +
        "`votes` = values(`votes`), `comments` = values(`comments`), " +
        "`engagement_score` = values(`engagement_score`)",
    ),
    true,
    rendered.text,
  );
});

Deno.test("core-only rollup: sqlite renders native FILTER + strftime", () => {
  const rendered = renderSql(rollup(), { dialect: "sqlite" });
  assertEquals(rendered.text.includes("filter (where"), true, rendered.text);
  assertEquals(rendered.text.includes("strftime("), true, rendered.text);
  assertEquals(
    rendered.text.includes('on conflict ("post_id", "bucket") do update set'),
    true,
    rendered.text,
  );
});
