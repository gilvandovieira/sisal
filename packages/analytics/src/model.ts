/**
 * The analytics descriptor model (v0.11 preview): windowed-metric descriptors
 * (`movingAvg`/`rank`/`lag`/`lead`/delta), analytics order terms
 * (`ascending`/`descending`), and the type machinery that infers an exact
 * result-row type from a query's dimension/metric/window maps.
 *
 * Descriptors are pure data — key references into the query's own dimension
 * and metric maps, resolved and compiled into core window expressions
 * (`over(...)`) only when the query renders. The v0.7 readiness prototype
 * pinned this shape; this module ships it.
 *
 * @module
 */

import { OrmError } from "@sisal/core";
import type {
  InferProjection,
  SelectColumnRef,
  SelectProjection,
  SqlExpression,
  WindowFrame,
} from "@sisal/core";

/**
 * A value a windowed metric may reference: the string key of a dimension or
 * metric declared on the same query, a column reference, or a SQL expression.
 */
export type WindowOperand<TKey extends string = string> =
  | TKey
  | SelectColumnRef
  | SqlExpression<unknown>;

/**
 * An ordering entry inside a window specification or the query-level
 * `orderBy(...)`: a bare operand (ascending) or an explicit
 * {@link ascending}/{@link descending} term.
 */
export type WindowOrderOperand<TKey extends string = string> =
  | WindowOperand<TKey>
  | AnalyticsOrderTerm<TKey>;

/**
 * An explicit ordering term produced by {@link ascending} / {@link descending}
 * — a key or expression plus a direction.
 */
export interface AnalyticsOrderTerm<TKey extends string = string> {
  /** Discriminator for an explicit analytics ordering term. */
  readonly kind: "analytics-order";
  /** Metric, dimension, or expression reference being ordered. */
  readonly ref: WindowOperand<TKey>;
  /** Sort direction for the ordering term. */
  readonly direction: "asc" | "desc";
}

/** Returns true when a value is an {@link AnalyticsOrderTerm}. */
export function isAnalyticsOrderTerm(
  value: unknown,
): value is AnalyticsOrderTerm {
  return typeof value === "object" && value !== null &&
    (value as { kind?: unknown }).kind === "analytics-order";
}

/**
 * Orders by a dimension/metric/window key or expression, ascending —
 * `orderBy(ascending("bucket"))`.
 */
export function ascending<TKey extends string>(
  ref: WindowOperand<TKey>,
): AnalyticsOrderTerm<TKey> {
  return Object.freeze({ kind: "analytics-order", ref, direction: "asc" });
}

/**
 * Orders by a dimension/metric/window key or expression, descending —
 * `rank({ orderBy: [descending("engagementScore")] })`.
 */
export function descending<TKey extends string>(
  ref: WindowOperand<TKey>,
): AnalyticsOrderTerm<TKey> {
  return Object.freeze({ kind: "analytics-order", ref, direction: "desc" });
}

/**
 * The partition/order options shared by every windowed-metric descriptor.
 * Keys reference the query's dimensions and metrics; the window itself
 * evaluates after grouping, so a referenced metric inlines its aggregate
 * expression (`avg(sum("votes")) over (…)` — valid on every supported
 * engine).
 */
export interface WindowedMetricSpec<TKey extends string = string> {
  /** Window partition keys (dimension/metric keys or expressions). */
  readonly partitionBy?: readonly WindowOperand<TKey>[];
  /** Window ordering (bare = ascending; wrap with {@link descending}). */
  readonly orderBy?: readonly WindowOrderOperand<TKey>[];
}

interface BaseWindowedMetric<TFn extends string, TKey extends string> {
  readonly kind: "windowed-metric";
  readonly fn: TFn;
  readonly partitionBy: readonly WindowOperand<TKey>[];
  readonly orderBy: readonly WindowOrderOperand<TKey>[];
}

/**
 * A trailing moving average over a metric — compiles to
 * `avg(metric) over (partition by … order by … rows between N-1 preceding
 * and current row)`.
 */
export interface MovingAvgMetric<
  TKey extends string = string,
> extends BaseWindowedMetric<"moving-avg", TKey> {
  /** The metric key or expression being averaged. */
  readonly ref: WindowOperand<TKey>;
  /** Window width in rows, current row included. */
  readonly rows: number;
}

/** A ranking windowed metric — `rank()`/`dense_rank()`/`row_number()`. */
export interface RankingMetric<
  TFn extends "rank" | "dense-rank" | "row-number" = "rank",
  TKey extends string = string,
> extends BaseWindowedMetric<TFn, TKey> {}

/**
 * A `lag()`/`lead()` windowed metric. `TRef` keeps the referenced metric
 * key's literal type so the result row infers the referenced metric's value
 * type (nullable — the offset row may fall outside the partition).
 */
export interface OffsetMetric<
  TFn extends "lag" | "lead" = "lag",
  TRef extends WindowOperand = string,
  TKey extends string = string,
> extends BaseWindowedMetric<TFn, TKey> {
  /** The metric key or expression being offset. */
  readonly ref: TRef;
  /** Row offset within the window order (default 1). */
  readonly offset: number;
}

/**
 * A period-over-period delta — `metric - lag(metric) over (…)`, the
 * difference between the current and previous window row.
 */
export interface DeltaMetric<
  TRef extends WindowOperand = string,
  TKey extends string = string,
> extends BaseWindowedMetric<"delta", TKey> {
  /** The metric key or expression being differenced. */
  readonly ref: TRef;
}

/** Any windowed-metric descriptor referencing at most the keys `TKey`. */
export type AnyWindowedMetric<TKey extends string = string> =
  | MovingAvgMetric<TKey>
  | RankingMetric<"rank" | "dense-rank" | "row-number", TKey>
  | OffsetMetric<"lag" | "lead", WindowOperand<TKey>, TKey>
  | DeltaMetric<WindowOperand<TKey>, TKey>;

/** Map of result key → windowed-metric descriptor. */
export type WindowedMetricMap<TKey extends string = string> = Record<
  string,
  AnyWindowedMetric<TKey>
>;

function frozenSpec<TKey extends string>(
  spec: WindowedMetricSpec<TKey>,
): {
  readonly partitionBy: readonly WindowOperand<TKey>[];
  readonly orderBy: readonly WindowOrderOperand<TKey>[];
} {
  return {
    partitionBy: Object.freeze([...(spec.partitionBy ?? [])]),
    orderBy: Object.freeze([...(spec.orderBy ?? [])]),
  };
}

function assertWindowOrder(
  fn: string,
  orderBy: readonly unknown[],
): void {
  if (orderBy.length === 0) {
    throw new OrmError(
      `${fn} requires a window \`orderBy\` — without one the engine's ` +
        `row order (and therefore the result) is undefined`,
      { code: "ORM_INVALID_QUERY", details: { fn } },
    );
  }
}

/**
 * A trailing moving average of a metric over the last `rows` window rows
 * (current row included) — the `/rising` feed's velocity score:
 * `movingAvg("votes", { partitionBy: ["postId"], orderBy: ["bucket"],
 * rows: 6 })`. Nullable: `avg` of an empty frame is NULL.
 */
export function movingAvg<TKey extends string>(
  metric: WindowOperand<TKey>,
  spec: WindowedMetricSpec<TKey> & {
    /** Window width in rows, current row included (a positive integer). */
    readonly rows: number;
  },
): MovingAvgMetric<TKey> {
  if (!Number.isInteger(spec.rows) || spec.rows < 1) {
    throw new OrmError("movingAvg rows must be a positive integer", {
      code: "ORM_INVALID_QUERY",
      details: { rows: spec.rows },
    });
  }
  assertWindowOrder("movingAvg", spec.orderBy ?? []);
  return Object.freeze({
    kind: "windowed-metric",
    fn: "moving-avg",
    ref: metric,
    rows: spec.rows,
    ...frozenSpec(spec),
  });
}

/**
 * Ranking with gaps over the window order — `rank() over (…)`:
 * `rank({ partitionBy: ["bucket"], orderBy: [descending("engagement")] })`.
 */
export function rank<TKey extends string>(
  spec: WindowedMetricSpec<TKey>,
): RankingMetric<"rank", TKey> {
  assertWindowOrder("rank", spec.orderBy ?? []);
  return Object.freeze({
    kind: "windowed-metric",
    fn: "rank",
    ...frozenSpec(spec),
  });
}

/** Ranking without gaps — `dense_rank() over (…)`. */
export function denseRank<TKey extends string>(
  spec: WindowedMetricSpec<TKey>,
): RankingMetric<"dense-rank", TKey> {
  assertWindowOrder("denseRank", spec.orderBy ?? []);
  return Object.freeze({
    kind: "windowed-metric",
    fn: "dense-rank",
    ...frozenSpec(spec),
  });
}

/** Sequential row numbering — `row_number() over (…)`. */
export function rowNumber<TKey extends string>(
  spec: WindowedMetricSpec<TKey>,
): RankingMetric<"row-number", TKey> {
  assertWindowOrder("rowNumber", spec.orderBy ?? []);
  return Object.freeze({
    kind: "windowed-metric",
    fn: "row-number",
    ...frozenSpec(spec),
  });
}

function offsetMetric<
  TFn extends "lag" | "lead",
  TRef extends WindowOperand<TKey>,
  TKey extends string,
>(
  fn: TFn,
  metric: TRef,
  spec: WindowedMetricSpec<TKey> & { readonly offset?: number },
): OffsetMetric<TFn, TRef, TKey> {
  const offset = spec.offset ?? 1;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new OrmError(`${fn} offset must be a non-negative integer`, {
      code: "ORM_INVALID_QUERY",
      details: { offset },
    });
  }
  assertWindowOrder(fn, spec.orderBy ?? []);
  return Object.freeze({
    kind: "windowed-metric",
    fn,
    ref: metric,
    offset,
    ...frozenSpec(spec),
  });
}

/**
 * The metric's value `offset` window rows before the current row —
 * `lag("votes", { partitionBy: ["postId"], orderBy: ["bucket"] })`. The
 * result row infers the referenced metric's value type, nullable.
 */
export function lag<
  TRef extends WindowOperand<TKey>,
  TKey extends string = string,
>(
  metric: TRef,
  spec: WindowedMetricSpec<TKey> & {
    /** Row offset within the window order (default 1). */
    readonly offset?: number;
  },
): OffsetMetric<"lag", TRef, TKey> {
  return offsetMetric("lag", metric, spec);
}

/** The metric's value `offset` window rows after the current row. */
export function lead<
  TRef extends WindowOperand<TKey>,
  TKey extends string = string,
>(
  metric: TRef,
  spec: WindowedMetricSpec<TKey> & {
    /** Row offset within the window order (default 1). */
    readonly offset?: number;
  },
): OffsetMetric<"lead", TRef, TKey> {
  return offsetMetric("lead", metric, spec);
}

/**
 * The difference between the metric's current and previous window rows —
 * `metric - lag(metric) over (…)`. Nullable: the first row of every
 * partition has no previous row.
 */
export function delta<
  TRef extends WindowOperand<TKey>,
  TKey extends string = string,
>(
  metric: TRef,
  spec: WindowedMetricSpec<TKey>,
): DeltaMetric<TRef, TKey> {
  assertWindowOrder("delta", spec.orderBy ?? []);
  return Object.freeze({
    kind: "windowed-metric",
    fn: "delta",
    ref: metric,
    ...frozenSpec(spec),
  });
}

/** The frame a {@link MovingAvgMetric} compiles to. */
export function movingAvgFrame(rows: number): WindowFrame {
  return {
    unit: "rows",
    start: { preceding: rows - 1 },
    end: "currentRow",
  };
}

/**
 * The value a windowed metric contributes to the result row, resolved
 * against the row the query's dimensions and metrics project: rankings are
 * `number`; moving averages and deltas are `number | null`; `lag`/`lead`
 * carry the referenced metric's value type, nullable.
 */
export type WindowedMetricValue<TMetric, TRow> = TMetric extends {
  readonly fn: "rank" | "dense-rank" | "row-number";
} ? number
  : TMetric extends { readonly fn: "moving-avg" } ? number | null
  : TMetric extends { readonly fn: "delta" } ? number | null
  : TMetric extends { readonly fn: "lag" | "lead"; readonly ref: infer TRef }
    ? TRef extends keyof TRow ? TRow[TRef] | null
    : TRef extends SqlExpression<infer TValue> ? TValue | null
    : unknown
  : never;

/**
 * The exact result-row type of an analytics query: dimension and metric
 * entries via the core projection inference, windowed metrics via
 * {@link WindowedMetricValue}. This is the v0.7 `InferAnalyticsRow`
 * prototype, shipped.
 */
export type AnalyticsRow<
  TDimensions extends SelectProjection,
  TMetrics extends SelectProjection,
  TWindows extends WindowedMetricMap,
> =
  & InferProjection<TDimensions>
  & InferProjection<TMetrics>
  & {
    readonly [K in keyof TWindows]: WindowedMetricValue<
      TWindows[K],
      InferProjection<TDimensions> & InferProjection<TMetrics>
    >;
  };

/**
 * The two comparison columns {@link compareToPreviousWindow} adds for a
 * metric key `K`: `` `${K}Previous` `` (the previous window's value) and
 * `` `${K}Delta` `` (current minus previous).
 */
export type PreviousWindowMetrics<TMetric extends string> =
  & {
    readonly [K in `${TMetric}Previous`]: OffsetMetric<"lag", TMetric, string>;
  }
  & {
    readonly [K in `${TMetric}Delta`]: DeltaMetric<TMetric, string>;
  };
