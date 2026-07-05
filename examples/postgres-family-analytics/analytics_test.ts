/**
 * Network-free dry-run tests for the analytics example: every query renders
 * through the public `@sisal/analytics` API to valid, parameterized Postgres
 * SQL, and each is capability-supported. No database, no raw SQL.
 */
import { assert, assertStringIncludes } from "@std/assert";
import { columns, defineTable } from "@sisal/orm";
import {
  bucket,
  countDistinct,
  descending,
  from,
  max,
  movingAvg,
  rank,
  sum,
  supportsQuery,
} from "@sisal/analytics";

const postHourlyStats = defineTable("post_hourly_stats", {
  postId: columns.bigint().notNull(),
  communityId: columns.text().notNull(),
  bucket: columns.timestamp({ withTimezone: true, mode: "date" }).notNull(),
  views: columns.integer().notNull(),
  votes: columns.integer().notNull(),
  comments: columns.integer().notNull(),
  engagementScore: columns.doublePrecision().notNull(),
});

const p = postHourlyStats.columns;

Deno.test("engagement over time renders with countDistinct + view delta", () => {
  const query = from(postHourlyStats)
    .dimensions({ hour: bucket("hour", p.bucket) })
    .metrics({
      views: sum(p.views),
      activePosts: countDistinct(p.postId),
    })
    .compareToPreviousWindow("views")
    .orderBy("hour");

  assert(supportsQuery(query, { dialect: "postgres" }).supported);
  const { text } = query.render({ dialect: "postgres" });
  assertStringIncludes(text, "date_trunc('hour'");
  assertStringIncludes(text, 'count(distinct "post_hourly_stats"."post_id")');
  assertStringIncludes(text, 'as "viewsPrevious"');
  assertStringIncludes(text, 'as "viewsDelta"');
});

Deno.test("rising feed renders movingAvg + community rank + vote delta", () => {
  const query = from(postHourlyStats)
    .dimensions({
      postId: p.postId,
      communityId: p.communityId,
      hour: bucket("hour", p.bucket),
    })
    .metrics({
      votes: sum(p.votes),
      engagement: max(p.engagementScore),
    })
    .windows({
      voteMa6h: movingAvg("votes", {
        partitionBy: ["postId"],
        orderBy: ["hour"],
        rows: 6,
      }),
      communityRank: rank({
        partitionBy: ["communityId", "hour"],
        orderBy: [descending("engagement")],
      }),
    })
    .compareToPreviousWindow("votes")
    .orderBy(descending("voteMa6h"))
    .limit(50);

  assert(supportsQuery(query, { dialect: "postgres" }).supported);
  const { text } = query.render({ dialect: "postgres" });
  assertStringIncludes(text, "rows between 5 preceding and current row");
  assertStringIncludes(text, "rank() over");
  assertStringIncludes(text, 'as "communityRank"');
  assertStringIncludes(text, 'as "votesPrevious"');
  assertStringIncludes(text, 'as "votesDelta"');
});
