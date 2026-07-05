/**
 * # @sisal/analytics — typed analytical queries for Sisal (v0.11 preview)
 *
 * A Postgres-first OLAP layer over the `@sisal/core` IR: define **metrics ×
 * dimensions × windows** as typed descriptor maps, get back one correct SQL
 * statement and a result-row type inferred from the definition. It
 * complements `@sisal/etl`: ETL builds the rollups, analytics queries them.
 *
 * - {@link from} — start a query over a table, rollup, or subquery.
 * - dimensions — typed group keys, including {@link bucket} time dimensions.
 * - metrics — `count`/`sum`/`avg`/`min`/`max`/`countDistinct` (re-exported
 *   from core) and the experimental {@link percentileCont} /
 *   {@link percentileDisc}.
 * - windowed metrics — {@link movingAvg}, {@link rank}, {@link denseRank},
 *   {@link rowNumber}, {@link lag}, {@link lead}, {@link delta}, referencing
 *   dimensions/metrics by key.
 * - {@link AnalyticsQuery.compareToPreviousWindow | compareToPreviousWindow}
 *   — period-over-period comparison along the {@link bucket} time axis.
 * - {@link supportsQuery} / {@link assertQuerySupported} — pre-flight
 *   capability gate: unsupported analytics fail typed, never silently
 *   degraded.
 *
 * Depends on `@sisal/core` only; executes through any adapter `Database`
 * (structurally — see {@link AnalyticsExecutor}). `@sisal/orm` never
 * imports this package.
 *
 * @module
 */

export {
  type AnalyticsExecutor,
  AnalyticsQuery,
  type AnalyticsSource,
  type CompareToPreviousWindowOptions,
  from,
} from "./src/query.ts";
export {
  type AnalyticsOrderTerm,
  type AnalyticsRow,
  type AnyWindowedMetric,
  ascending,
  delta,
  type DeltaMetric,
  denseRank,
  descending,
  isAnalyticsOrderTerm,
  lag,
  lead,
  movingAvg,
  type MovingAvgMetric,
  type OffsetMetric,
  type PreviousWindowMetrics,
  rank,
  type RankingMetric,
  rowNumber,
  type WindowedMetricMap,
  type WindowedMetricSpec,
  type WindowedMetricValue,
  type WindowOperand,
  type WindowOrderOperand,
} from "./src/model.ts";
export { bucket, isTimeBucket } from "./src/bucket.ts";
export { percentileCont, percentileDisc } from "./src/percentile.ts";
export {
  type AnalyticsQuerySupport,
  assertQuerySupported,
  supportsQuery,
} from "./src/capability.ts";
export { avg, count, countDistinct, max, min, sum } from "@sisal/core";
