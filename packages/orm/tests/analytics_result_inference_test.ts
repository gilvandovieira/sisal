/**
 * Analytics result-inference prototype (v0.7.0 workstream A, task A2).
 *
 * This is intentionally local to the test file: it proves the future
 * `@sisal/analytics` metric/dimension descriptor shape can infer an exact row
 * type from maps, without shipping an analytics package or public API.
 *
 * @module
 */
import {
  avg,
  columns,
  count,
  dateTrunc,
  defineTable,
  sql,
  type SqlExpression,
  sum,
} from "../mod.ts";

interface AnalyticsDimension<T> {
  readonly kind: "dimension";
  readonly expression: SqlExpression<T>;
  readonly __value?: T;
}

interface AnalyticsMetric<T> {
  readonly kind: "metric";
  readonly expression: SqlExpression<T>;
  readonly __value?: T;
}

interface AnalyticsDerivedField<T> {
  readonly kind: "derivedField";
  readonly expression: SqlExpression<T>;
  readonly __value?: T;
}

type AnalyticsDimensionMap = Record<string, AnalyticsDimension<unknown>>;
type AnalyticsMetricMap = Record<string, AnalyticsMetric<unknown>>;
type AnalyticsDerivedFieldMap = Record<
  string,
  AnalyticsDerivedField<unknown>
>;

interface AnalyticsSpec<
  TDimensions extends AnalyticsDimensionMap,
  TMetrics extends AnalyticsMetricMap,
  TDerived extends AnalyticsDerivedFieldMap,
> {
  readonly kind: "analyticsSpec";
  readonly dimensions: TDimensions;
  readonly metrics: TMetrics;
  readonly derivedFields: TDerived;
}

type DimensionValue<TValue> = TValue extends AnalyticsDimension<infer T> ? T
  : never;
type MetricValue<TValue> = TValue extends AnalyticsMetric<infer T> ? T : never;
type DerivedValue<TValue> = TValue extends AnalyticsDerivedField<infer T> ? T
  : never;

type InferAnalyticsRow<TSpec> = TSpec extends AnalyticsSpec<
  infer TDimensions,
  infer TMetrics,
  infer TDerived
> ? {
    readonly [
      K in keyof TDimensions | keyof TMetrics | keyof TDerived
    ]: K extends keyof TDimensions ? DimensionValue<TDimensions[K]>
      : K extends keyof TMetrics ? MetricValue<TMetrics[K]>
      : K extends keyof TDerived ? DerivedValue<TDerived[K]>
      : never;
  }
  : never;

function dimension<T>(expression: SqlExpression<T>): AnalyticsDimension<T> {
  return Object.freeze({ kind: "dimension", expression });
}

function metric<T>(expression: SqlExpression<T>): AnalyticsMetric<T> {
  return Object.freeze({ kind: "metric", expression });
}

function derivedField<T>(
  expression: SqlExpression<T>,
): AnalyticsDerivedField<T> {
  return Object.freeze({ kind: "derivedField", expression });
}

function analyticsSpec<
  const TDimensions extends AnalyticsDimensionMap,
  const TMetrics extends AnalyticsMetricMap,
  const TDerived extends AnalyticsDerivedFieldMap = Record<never, never>,
>(
  spec: {
    readonly dimensions: TDimensions;
    readonly metrics: TMetrics;
    readonly derivedFields?: TDerived;
  },
): AnalyticsSpec<TDimensions, TMetrics, TDerived> {
  return Object.freeze({
    kind: "analyticsSpec",
    dimensions: spec.dimensions,
    metrics: spec.metrics,
    derivedFields: spec.derivedFields ?? ({} as TDerived),
  });
}

type Equal<TLeft, TRight> = (<T>() => T extends TLeft ? 1 : 2) extends
  (<T>() => T extends TRight ? 1 : 2) ? true
  : false;
type Assert<T extends true> = T;

const postHourlyStats = defineTable("post_hourly_stats", {
  postId: columns.bigint().notNull(),
  communityId: columns.text().notNull(),
  bucket: columns.timestamp({ withTimezone: true, mode: "date" }).notNull(),
  views: columns.integer().notNull(),
  votes: columns.integer().notNull(),
  comments: columns.integer().notNull(),
  engagementScore: columns.doublePrecision().notNull(),
});

const columnExpression = <T>(column: unknown): SqlExpression<T> =>
  sql`${column}` as SqlExpression<T>;

const dimensionOnlySpec = analyticsSpec({
  dimensions: {
    bucket: dimension(dateTrunc("hour", postHourlyStats.columns.bucket)),
    communityId: dimension<string>(
      columnExpression(postHourlyStats.columns.communityId),
    ),
  },
  metrics: {},
});

const risingSpec = analyticsSpec({
  dimensions: {
    postId: dimension<string>(columnExpression(postHourlyStats.columns.postId)),
    communityId: dimension<string>(
      columnExpression(postHourlyStats.columns.communityId),
    ),
    bucket: dimension(dateTrunc("hour", postHourlyStats.columns.bucket)),
  },
  metrics: {
    viewCount: metric(count()),
    voteTotal: metric(sum(postHourlyStats.columns.votes)),
    voteMovingAverage6h: metric(avg(postHourlyStats.columns.votes)),
    hourRank: metric<number>(
      sql`rank() over (
        partition by ${postHourlyStats.columns.communityId},
          ${postHourlyStats.columns.bucket}
        order by ${postHourlyStats.columns.engagementScore} desc
      )` as SqlExpression<number>,
    ),
  },
  derivedFields: {
    risingScore: derivedField<number>(
      sql`${avg(postHourlyStats.columns.votes)} * 2.0 + ${
        sum(postHourlyStats.columns.comments)
      } * 0.5` as SqlExpression<number>,
    ),
    voteDelta: derivedField<number | null>(
      sql`${sum(postHourlyStats.columns.votes)} - lag(${
        sum(postHourlyStats.columns.votes)
      }) over (
        partition by ${postHourlyStats.columns.postId}
        order by ${postHourlyStats.columns.bucket}
      )` as SqlExpression<number | null>,
    ),
  },
});

type RisingRow = InferAnalyticsRow<typeof risingSpec>;

const dimensionKeysAreReadonly: Assert<
  Equal<
    InferAnalyticsRow<typeof dimensionOnlySpec>,
    {
      readonly bucket: string;
      readonly communityId: string;
    }
  >
> = true;

const metricNullabilityIsPreserved: Assert<
  Equal<
    Pick<RisingRow, "voteMovingAverage6h" | "voteTotal">,
    {
      readonly voteMovingAverage6h: number | null;
      readonly voteTotal: number | null;
    }
  >
> = true;

const derivedFieldsAreIncluded: Assert<
  Equal<
    Pick<RisingRow, "risingScore" | "voteDelta">,
    {
      readonly risingScore: number;
      readonly voteDelta: number | null;
    }
  >
> = true;

const risingFeedRowIsExact: Assert<
  Equal<
    RisingRow,
    {
      readonly postId: string;
      readonly communityId: string;
      readonly bucket: string;
      readonly viewCount: number;
      readonly voteTotal: number | null;
      readonly voteMovingAverage6h: number | null;
      readonly hourRank: number;
      readonly risingScore: number;
      readonly voteDelta: number | null;
    }
  >
> = true;

Deno.test("analytics result inference prototype compiles", () => {
  const checks = [
    dimensionKeysAreReadonly,
    metricNullabilityIsPreserved,
    derivedFieldsAreIncluded,
    risingFeedRowIsExact,
  ];
  if (!checks.every(Boolean)) {
    throw new Error("analytics inference type assertions failed");
  }
});
