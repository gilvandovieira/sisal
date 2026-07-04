/**
 * v0.11 preview examples as executable dry-runs: the five roadmap examples
 * render through the public analytics API without raw SQL or a live database.
 */
import { assertStringIncludes } from "@std/assert";
import { columns, defineTable, gte } from "@sisal/core";
import {
  bucket,
  countDistinct,
  descending,
  from,
  max,
  movingAvg,
  rank,
  sum,
} from "./mod.ts";

const postHourlyStats = defineTable("post_hourly_stats", {
  postId: columns.bigint().notNull(),
  communityId: columns.text().notNull(),
  bucket: columns.timestamp({ withTimezone: true, mode: "date" }).notNull(),
  views: columns.integer().notNull(),
  votes: columns.integer().notNull(),
  comments: columns.integer().notNull(),
  engagementScore: columns.doublePrecision().notNull(),
});

const userEvents = defineTable("user_events", {
  userId: columns.bigint().notNull(),
  occurredAt: columns.timestamp({ withTimezone: true, mode: "date" }).notNull(),
});

const p = postHourlyStats.columns;
const u = userEvents.columns;
const SINCE = "2026-01-01T00:00:00.000Z";

Deno.test("examples: post engagement over time", () => {
  const query = from(postHourlyStats)
    .where(gte(p.bucket, SINCE))
    .dimensions({ bucket: bucket("hour", p.bucket) })
    .metrics({
      views: sum(p.views),
      votes: sum(p.votes),
      comments: sum(p.comments),
    })
    .orderBy("bucket");

  const rendered = query.render({ dialect: "postgres" });
  assertStringIncludes(rendered.text, "date_trunc('hour',");
  assertStringIncludes(rendered.text, 'sum("post_hourly_stats"."views")');
  assertStringIncludes(rendered.text, 'order by "bucket" asc');
});

Deno.test("examples: active users by day", () => {
  const query = from(userEvents)
    .where(gte(u.occurredAt, SINCE))
    .dimensions({ day: bucket("day", u.occurredAt) })
    .metrics({ activeUsers: countDistinct(u.userId) })
    .orderBy("day");

  const rendered = query.render({ dialect: "postgres" });
  assertStringIncludes(rendered.text, "date_trunc('day'");
  assertStringIncludes(
    rendered.text,
    'count(distinct "user_events"."user_id")',
  );
  assertStringIncludes(rendered.text, 'as "activeUsers"');
});

Deno.test("examples: top posts by engagement", () => {
  const query = from(postHourlyStats)
    .where(gte(p.bucket, SINCE))
    .dimensions({
      postId: p.postId,
      bucket: bucket("hour", p.bucket),
    })
    .metrics({ engagement: max(p.engagementScore) })
    .windows({
      engagementRank: rank({
        partitionBy: ["bucket"],
        orderBy: [descending("engagement")],
      }),
    })
    .orderBy("bucket", "engagementRank")
    .limit(100);

  const rendered = query.render({ dialect: "postgres" });
  assertStringIncludes(rendered.text, "rank() over");
  assertStringIncludes(
    rendered.text,
    'order by max("post_hourly_stats"."engagement_score") desc',
  );
  assertStringIncludes(rendered.text, "limit $2");
});

Deno.test("examples: rising feed recent velocity", () => {
  const query = from(postHourlyStats)
    .where(gte(p.bucket, SINCE))
    .dimensions({
      postId: p.postId,
      communityId: p.communityId,
      bucket: bucket("hour", p.bucket),
    })
    .metrics({
      votes: sum(p.votes),
      comments: sum(p.comments),
      engagement: max(p.engagementScore),
    })
    .windows({
      voteMa6h: movingAvg("votes", {
        partitionBy: ["postId"],
        orderBy: ["bucket"],
        rows: 6,
      }),
      communityRank: rank({
        partitionBy: ["communityId", "bucket"],
        orderBy: [descending("engagement")],
      }),
    })
    .compareToPreviousWindow("votes")
    .orderBy(descending("voteMa6h"))
    .limit(50);

  const rendered = query.render({ dialect: "postgres" });
  assertStringIncludes(
    rendered.text,
    "rows between 5 preceding and current row",
  );
  assertStringIncludes(rendered.text, 'as "votesPrevious"');
  assertStringIncludes(rendered.text, 'as "votesDelta"');
  assertStringIncludes(rendered.text, 'as "communityRank"');
});

Deno.test("examples: presentation-ready rollup time series", () => {
  const query = from(postHourlyStats)
    .where(gte(p.bucket, SINCE))
    .dimensions({ bucket: bucket("day", p.bucket) })
    .metrics({
      views: sum(p.views),
      votes: sum(p.votes),
    })
    .compareToPreviousWindow("views")
    .orderBy("bucket");

  const rendered = query.render({ dialect: "postgres" });
  assertStringIncludes(rendered.text, 'as "viewsPrevious"');
  assertStringIncludes(rendered.text, 'as "viewsDelta"');
  assertStringIncludes(rendered.text, 'order by "bucket" asc');
});
