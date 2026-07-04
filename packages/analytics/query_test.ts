/**
 * v0.11 analytics preview tests: typed dimensions/metrics/windows, period
 * comparison, percentile capability gating, and result-row inference.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  columns,
  countDistinct,
  defineTable,
  gte,
  OrmError,
  renderSql,
  sum,
} from "@sisal/core";
import type { Sql, SqlExpression } from "@sisal/core";
import {
  type AnalyticsQuery,
  type AnalyticsRow,
  bucket,
  descending,
  from,
  movingAvg,
  percentileCont,
  rank,
  supportsQuery,
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

const s = postHourlyStats.columns;
const SINCE = "2026-01-01T00:00:00.000Z";

const risingQuery = from(postHourlyStats)
  .where(gte(s.bucket, SINCE))
  .dimensions({
    postId: s.postId,
    bucket: bucket("hour", s.bucket),
  })
  .metrics({
    views: sum(s.views),
    votes: sum(s.votes),
    activePosts: countDistinct(s.postId),
  })
  .windows({
    voteMa3h: movingAvg("votes", {
      partitionBy: ["postId"],
      orderBy: ["bucket"],
      rows: 3,
    }),
    position: rank({
      partitionBy: ["bucket"],
      orderBy: [descending("votes")],
    }),
  })
  .compareToPreviousWindow("votes")
  .orderBy(descending("voteMa3h"))
  .limit(20);

type Equal<TLeft, TRight> = (<T>() => T extends TLeft ? 1 : 2) extends
  (<T>() => T extends TRight ? 1 : 2) ? true
  : false;
type Assert<T extends true> = T;
type Simplify<T> = { readonly [K in keyof T]: T[K] };

type RowOf<TQuery> = TQuery extends AnalyticsQuery<
  infer TDimensions,
  infer TMetrics,
  infer TWindows
> ? AnalyticsRow<TDimensions, TMetrics, TWindows>
  : never;

const risingRowIsExact: Assert<
  Equal<
    Simplify<RowOf<typeof risingQuery>>,
    {
      readonly postId: string;
      readonly bucket: string;
      readonly views: number | null;
      readonly votes: number | null;
      readonly activePosts: number;
      readonly voteMa3h: number | null;
      readonly position: number;
      readonly votesPrevious: number | null;
      readonly votesDelta: number | null;
    }
  >
> = true;

function pg(fragment: Sql) {
  return renderSql(fragment, { dialect: "postgres" });
}

Deno.test("analytics: row inference compiles exactly", () => {
  assert(risingRowIsExact);
});

Deno.test("analytics: dimensions, metrics, windows, comparison render", () => {
  const rendered = pg(risingQuery.toSql());
  const hourBucket =
    `to_char(date_trunc('hour', "post_hourly_stats"."bucket"), ` +
    `'YYYY-MM-DD HH24:MI:SS')`;
  assertEquals(
    rendered.text,
    'select "post_hourly_stats"."post_id" as "postId", ' +
      `${hourBucket} as "bucket", ` +
      'sum("post_hourly_stats"."views") as "views", ' +
      'sum("post_hourly_stats"."votes") as "votes", ' +
      'count(distinct "post_hourly_stats"."post_id") as "activePosts", ' +
      'avg(sum("post_hourly_stats"."votes")) over (' +
      'partition by "post_hourly_stats"."post_id" ' +
      `order by ${hourBucket} ` +
      'rows between 2 preceding and current row) as "voteMa3h", ' +
      "rank() over (" +
      `partition by ${hourBucket} ` +
      'order by sum("post_hourly_stats"."votes") desc) as "position", ' +
      'lag(sum("post_hourly_stats"."votes"), 1) over (' +
      'partition by "post_hourly_stats"."post_id" ' +
      `order by ${hourBucket}) ` +
      'as "votesPrevious", ' +
      'sum("post_hourly_stats"."votes") - ' +
      'lag(sum("post_hourly_stats"."votes"), 1) over (' +
      'partition by "post_hourly_stats"."post_id" ' +
      `order by ${hourBucket}) ` +
      'as "votesDelta" from "post_hourly_stats" ' +
      'where "post_hourly_stats"."bucket" >= $1 ' +
      'group by "post_hourly_stats"."post_id", ' +
      `${hourBucket} ` +
      'order by "voteMa3h" desc limit $2',
  );
  assertEquals(rendered.params, [SINCE, 20]);
});

Deno.test("analytics: percentile renders on Postgres and gates SQLite", () => {
  const query = from(postHourlyStats)
    .dimensions({ bucket: bucket("day", s.bucket) })
    .metrics({ medianScore: percentileCont(0.5, s.engagementScore) });

  const rendered = pg(query.toSql());
  assertStringIncludes(
    rendered.text,
    "percentile_cont($1) within group " +
      '(order by "post_hourly_stats"."engagement_score")',
  );
  assertEquals(rendered.params, [0.5]);

  const support = supportsQuery(query, { dialect: "sqlite" });
  assertEquals(support.supported, false);
  if (!support.supported) {
    assertStringIncludes(support.reason, "percentile_cont/percentile_disc");
  }
});

Deno.test("analytics: execute fails closed before unsupported engines run", async () => {
  const query = from(postHourlyStats)
    .dimensions({ bucket: bucket("day", s.bucket) })
    .metrics({ medianScore: percentileCont(0.5, s.engagementScore) });
  let executed = false;

  const error = await assertRejects(
    () =>
      query.execute({
        dialectIdentity: { dialect: "sqlite" },
        execute() {
          executed = true;
          return Promise.resolve({ rows: [] });
        },
      }),
    OrmError,
  );

  assertEquals(error.code, "ANALYTICS_UNSUPPORTED_QUERY");
  assertEquals(executed, false);
});

Deno.test("analytics: unknown references fail at declaration time", () => {
  const error = assertThrows(
    () =>
      from(postHourlyStats)
        .dimensions({ postId: s.postId })
        .metrics({ votes: sum(s.votes) })
        .windows({
          nope: movingAvg("missing", {
            partitionBy: ["postId"],
            orderBy: ["postId"],
            rows: 2,
          }),
        } as never),
    OrmError,
  );
  assertEquals(error.code, "ORM_INVALID_QUERY");
  assertStringIncludes(error.message, 'unknown key "missing"');
});

Deno.test("analytics: comparison needs a single time bucket", () => {
  const query = from(postHourlyStats)
    .dimensions({ postId: s.postId })
    .metrics({ votes: sum(s.votes) });
  const error = assertThrows(
    () => query.compareToPreviousWindow("votes"),
    OrmError,
  );
  assertEquals(error.code, "ORM_INVALID_QUERY");
  assertStringIncludes(error.message, "needs a time axis");
});

const expressionLagQuery = from(postHourlyStats)
  .dimensions({ bucket: bucket("hour", s.bucket) })
  .metrics({ votes: sum(s.votes) })
  .windows({
    previousRaw: movingAvg(
      sum(s.comments) as SqlExpression<number | null>,
      { orderBy: ["bucket"], rows: 2 },
    ),
  });

type ExpressionLagRow = RowOf<typeof expressionLagQuery>;

const expressionWindowInference: Assert<
  Equal<
    Pick<ExpressionLagRow, "previousRaw">,
    { readonly previousRaw: number | null }
  >
> = true;

Deno.test("analytics: expression windows keep their expression type", () => {
  assert(expressionWindowInference);
});
