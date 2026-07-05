/**
 * The typed analytical query (v0.11 preview): {@link from} starts a query
 * over a table, rollup, or subquery; `dimensions`/`metrics`/`windows`
 * accumulate typed descriptor maps; `toSql()` compiles the whole thing into
 * one `@sisal/core` `assembleSelect` statement — dimensions project and
 * group, metrics aggregate, windowed metrics inline their referenced
 * aggregates inside `over (…)` (windows evaluate after grouping, so
 * `avg(sum("votes")) over (…)` is the correct, portable lowering).
 *
 * The builder is immutable — every method returns a new query — and the
 * result-row type is inferred from the descriptor maps
 * ({@link AnalyticsRow}), so `execute()` returns exactly the rows the
 * definition promises. Postgres-first: constructs another dialect cannot
 * express fail at render time with the typed `ORM_DIALECT_UNSUPPORTED`
 * error, never with silently different SQL.
 *
 * @module
 */

import {
  and,
  asc as coreAsc,
  assembleSelect,
  avg as coreAvg,
  denseRank as coreDenseRank,
  desc as coreDesc,
  identifier,
  isSql,
  isTable,
  lag as coreLag,
  lead as coreLead,
  OrmError,
  over,
  rank as coreRank,
  renderSql,
  rowNumber as coreRowNumber,
  sql,
} from "@sisal/core";
import type {
  Condition,
  DialectIdentity,
  OrderTerm,
  SelectProjection,
  Sql,
  SqlDialect,
  SqlExpression,
  SqlQuery,
  TableDefinition,
  WindowSpec,
} from "@sisal/core";
import { isTimeBucket } from "./bucket.ts";
import { assertQuerySupported } from "./capability.ts";
import {
  type AnalyticsRow,
  type AnyWindowedMetric,
  isAnalyticsOrderTerm,
  movingAvgFrame,
  type PreviousWindowMetrics,
  type WindowedMetricMap,
  type WindowOperand,
  type WindowOrderOperand,
} from "./model.ts";

/** An analytics source: a table/rollup definition or a subquery fragment. */
export type AnalyticsSource = TableDefinition | Sql;

/**
 * The executor an analytics query runs against — structurally satisfied by
 * every adapter's `Database` (the query never imports one): a detected
 * dialect identity plus `execute`.
 */
export interface AnalyticsExecutor {
  /** The adapter-detected `(dialect, variant, version)` identity. */
  readonly dialectIdentity: DialectIdentity;
  /** Executes a rendered statement and returns its rows. */
  execute<T = unknown>(statement: Sql): Promise<{ readonly rows: T[] }>;
}

/** Options for {@link AnalyticsQuery.compareToPreviousWindow}. */
export interface CompareToPreviousWindowOptions<TKey extends string = string> {
  /**
   * Partition keys for the comparison (default: every dimension except the
   * time bucket).
   */
  readonly partitionBy?: readonly TKey[];
  /**
   * The time-axis dimension key ordering the comparison (default: the
   * query's single {@link bucket} dimension).
   */
  readonly orderBy?: TKey;
}

interface AnalyticsQueryState {
  readonly source: AnalyticsSource;
  readonly condition: Condition | undefined;
  readonly dimensions: Readonly<Record<string, unknown>>;
  readonly metrics: Readonly<Record<string, unknown>>;
  readonly windows: Readonly<Record<string, AnyWindowedMetric>>;
  readonly order: readonly WindowOrderOperand[];
  readonly limitValue: number | undefined;
}

function assertFreshKeys(
  state: AnalyticsQueryState,
  incoming: Readonly<Record<string, unknown>>,
  role: string,
): void {
  for (const key of Object.keys(incoming)) {
    if (
      Object.hasOwn(state.dimensions, key) ||
      Object.hasOwn(state.metrics, key) ||
      Object.hasOwn(state.windows, key)
    ) {
      throw new OrmError(
        `Analytics ${role} key "${key}" is already declared on this query`,
        { code: "ORM_INVALID_QUERY", details: { key, role } },
      );
    }
  }
}

// Resolves a descriptor's key reference to the declared dimension/metric
// value (column or expression); columns and expressions pass through.
function resolveOperand(
  state: AnalyticsQueryState,
  operand: WindowOperand,
): unknown {
  if (typeof operand !== "string") {
    return operand;
  }
  if (Object.hasOwn(state.dimensions, operand)) {
    return state.dimensions[operand];
  }
  if (Object.hasOwn(state.metrics, operand)) {
    return state.metrics[operand];
  }
  throw new OrmError(
    `Analytics window references unknown key "${operand}" — declare it as ` +
      `a dimension or metric first (known: ${
        [...Object.keys(state.dimensions), ...Object.keys(state.metrics)]
          .join(", ") || "none"
      })`,
    { code: "ORM_INVALID_QUERY", details: { key: operand } },
  );
}

function resolveWindowOrder(
  state: AnalyticsQueryState,
  term: WindowOrderOperand,
): OrderTerm | unknown {
  if (isAnalyticsOrderTerm(term)) {
    const operand = resolveOperand(state, term.ref);
    return term.direction === "desc" ? coreDesc(operand) : coreAsc(operand);
  }
  return resolveOperand(state, term);
}

function windowSpec(
  state: AnalyticsQueryState,
  metric: AnyWindowedMetric,
): WindowSpec {
  return {
    ...(metric.partitionBy.length > 0
      ? {
        partitionBy: metric.partitionBy.map((operand) =>
          resolveOperand(state, operand)
        ),
      }
      : {}),
    ...(metric.orderBy.length > 0
      ? {
        orderBy: metric.orderBy.map((term) => resolveWindowOrder(state, term)),
      }
      : {}),
    ...(metric.fn === "moving-avg"
      ? { frame: movingAvgFrame(metric.rows) }
      : {}),
  };
}

function compileWindowedMetric(
  state: AnalyticsQueryState,
  metric: AnyWindowedMetric,
): SqlExpression<unknown> {
  const spec = windowSpec(state, metric);
  switch (metric.fn) {
    case "rank":
      return over(coreRank(), spec);
    case "dense-rank":
      return over(coreDenseRank(), spec);
    case "row-number":
      return over(coreRowNumber(), spec);
    case "moving-avg":
      return over(coreAvg(resolveOperand(state, metric.ref)), spec);
    case "lag":
      return over(
        coreLag(resolveOperand(state, metric.ref), metric.offset),
        spec,
      );
    case "lead":
      return over(
        coreLead(resolveOperand(state, metric.ref), metric.offset),
        spec,
      );
    case "delta": {
      const operand = resolveOperand(state, metric.ref);
      return sql`${operand} - ${
        over(coreLag(operand, 1), spec)
      }` as SqlExpression<unknown>;
    }
  }
}

// Query-level ORDER BY: output keys order by their projected alias (portable
// on every supported engine); expressions order verbatim.
function resolveQueryOrder(
  state: AnalyticsQueryState,
  term: WindowOrderOperand,
): OrderTerm {
  const [ref, direction] = isAnalyticsOrderTerm(term)
    ? [term.ref, term.direction]
    : [term, "asc" as const];
  let operand: unknown;
  if (typeof ref === "string") {
    if (
      !Object.hasOwn(state.dimensions, ref) &&
      !Object.hasOwn(state.metrics, ref) &&
      !Object.hasOwn(state.windows, ref)
    ) {
      throw new OrmError(
        `Analytics orderBy references unknown key "${ref}"`,
        { code: "ORM_INVALID_QUERY", details: { key: ref } },
      );
    }
    operand = identifier(ref);
  } else {
    operand = ref;
  }
  return direction === "desc" ? coreDesc(operand) : coreAsc(operand);
}

/**
 * A typed, immutable analytical query — see the module doc for the model.
 * Build with {@link from}; every method returns a new query.
 */
export class AnalyticsQuery<
  TDimensions extends SelectProjection = Record<never, never>,
  TMetrics extends SelectProjection = Record<never, never>,
  TWindows extends WindowedMetricMap = Record<never, never>,
> {
  readonly #state: AnalyticsQueryState;

  private constructor(state: AnalyticsQueryState) {
    this.#state = state;
  }

  /** Starts a query over a table/rollup definition or subquery fragment. */
  static create(source: AnalyticsSource): AnalyticsQuery {
    if (!isTable(source) && !isSql(source)) {
      throw new OrmError(
        "Analytics source must be a table definition or a SQL fragment",
        { code: "ORM_INVALID_QUERY" },
      );
    }
    return new AnalyticsQuery({
      source,
      condition: undefined,
      dimensions: {},
      metrics: {},
      windows: {},
      order: [],
      limitValue: undefined,
    });
  }

  #with(patch: Partial<AnalyticsQueryState>): AnalyticsQueryState {
    return { ...this.#state, ...patch };
  }

  /**
   * Filters source rows **before** aggregation (`WHERE`, not `HAVING`).
   * Multiple calls AND together.
   */
  where(
    condition: Condition,
  ): AnalyticsQuery<TDimensions, TMetrics, TWindows> {
    const merged = this.#state.condition === undefined
      ? condition
      : and(this.#state.condition, condition);
    return new AnalyticsQuery(this.#with({ condition: merged }));
  }

  /**
   * Declares typed group keys — columns or expressions (including
   * {@link bucket} time dimensions). Dimensions project **and** group;
   * their keys become result-row properties. Merges with previously
   * declared dimensions; duplicate keys throw.
   */
  dimensions<TAdded extends SelectProjection>(
    dimensions: TAdded,
  ): AnalyticsQuery<TDimensions & TAdded, TMetrics, TWindows> {
    assertFreshKeys(this.#state, dimensions, "dimension");
    return new AnalyticsQuery(this.#with({
      dimensions: { ...this.#state.dimensions, ...dimensions },
    })) as AnalyticsQuery<TDimensions & TAdded, TMetrics, TWindows>;
  }

  /**
   * Declares typed aggregate metrics — `count()`, `sum(…)`, `avg(…)`,
   * `min(…)`, `max(…)`, `countDistinct(…)`, or any aggregate expression
   * (including the experimental percentiles). Keys become result-row
   * properties; windowed metrics may reference them by key.
   */
  metrics<TAdded extends SelectProjection>(
    metrics: TAdded,
  ): AnalyticsQuery<TDimensions, TMetrics & TAdded, TWindows> {
    assertFreshKeys(this.#state, metrics, "metric");
    return new AnalyticsQuery(this.#with({
      metrics: { ...this.#state.metrics, ...metrics },
    })) as AnalyticsQuery<TDimensions, TMetrics & TAdded, TWindows>;
  }

  /**
   * Declares windowed metrics — {@link movingAvg}, {@link rank},
   * {@link denseRank}, {@link rowNumber}, {@link lag}, {@link lead},
   * {@link delta}. Descriptors reference the query's dimensions and metrics
   * by key (typed — an unknown key is a compile-time and runtime error).
   */
  windows<
    TAdded extends WindowedMetricMap<
      Extract<keyof TDimensions | keyof TMetrics, string>
    >,
  >(
    windows: TAdded,
  ): AnalyticsQuery<TDimensions, TMetrics, TWindows & TAdded> {
    assertFreshKeys(this.#state, windows, "window");
    for (const metric of Object.values(windows)) {
      for (
        const operand of [
          ...(metric.partitionBy ?? []),
          ...(metric.orderBy ?? []),
          ...("ref" in metric ? [metric.ref] : []),
        ]
      ) {
        const ref = isAnalyticsOrderTerm(operand) ? operand.ref : operand;
        if (typeof ref === "string") {
          resolveOperand(this.#state, ref);
        }
      }
    }
    return new AnalyticsQuery(this.#with({
      windows: { ...this.#state.windows, ...windows },
    })) as unknown as AnalyticsQuery<TDimensions, TMetrics, TWindows & TAdded>;
  }

  /**
   * Period-over-period comparison for a metric: adds
   * `` `${metric}Previous` `` (the previous window's value) and
   * `` `${metric}Delta` `` (current minus previous), partitioned by every
   * non-time dimension and ordered by the query's {@link bucket} time
   * dimension. Override either default via `options`; a query with no (or
   * more than one) time bucket requires an explicit `options.orderBy`.
   */
  compareToPreviousWindow<TMetric extends Extract<keyof TMetrics, string>>(
    metric: TMetric,
    options: CompareToPreviousWindowOptions<
      Extract<keyof TDimensions, string>
    > = {},
  ): AnalyticsQuery<
    TDimensions,
    TMetrics,
    TWindows & PreviousWindowMetrics<TMetric>
  > {
    if (!Object.hasOwn(this.#state.metrics, metric)) {
      throw new OrmError(
        `compareToPreviousWindow references unknown metric "${metric}"`,
        { code: "ORM_INVALID_QUERY", details: { metric } },
      );
    }
    const dimensionKeys = Object.keys(this.#state.dimensions);
    const timeKeys = dimensionKeys.filter((key) =>
      isTimeBucket(this.#state.dimensions[key])
    );
    const timeKey = options.orderBy ??
      (timeKeys.length === 1 ? timeKeys[0] : undefined);
    if (timeKey === undefined) {
      throw new OrmError(
        timeKeys.length === 0
          ? "compareToPreviousWindow needs a time axis — declare a bucket() " +
            "dimension or pass options.orderBy"
          : "compareToPreviousWindow found several bucket() dimensions " +
            `(${timeKeys.join(", ")}) — pass options.orderBy to pick one`,
        { code: "ORM_INVALID_QUERY", details: { timeKeys } },
      );
    }
    if (!Object.hasOwn(this.#state.dimensions, timeKey)) {
      throw new OrmError(
        `compareToPreviousWindow orderBy references unknown dimension ` +
          `"${timeKey}"`,
        { code: "ORM_INVALID_QUERY", details: { orderBy: timeKey } },
      );
    }
    const partitionBy = options.partitionBy ??
      dimensionKeys.filter((key) => key !== timeKey);
    for (const key of partitionBy) {
      if (!Object.hasOwn(this.#state.dimensions, key)) {
        throw new OrmError(
          `compareToPreviousWindow partitionBy references unknown ` +
            `dimension "${key}"`,
          { code: "ORM_INVALID_QUERY", details: { partitionBy: key } },
        );
      }
    }
    const spec = {
      kind: "windowed-metric" as const,
      partitionBy: Object.freeze([...partitionBy]),
      orderBy: Object.freeze([timeKey]),
    };
    const comparison = {
      [`${metric}Previous`]: Object.freeze({
        ...spec,
        fn: "lag" as const,
        ref: metric,
        offset: 1,
      }),
      [`${metric}Delta`]: Object.freeze({
        ...spec,
        fn: "delta" as const,
        ref: metric,
      }),
    } as Record<string, AnyWindowedMetric>;
    assertFreshKeys(this.#state, comparison, "window");
    return new AnalyticsQuery(this.#with({
      windows: { ...this.#state.windows, ...comparison },
    })) as unknown as AnalyticsQuery<
      TDimensions,
      TMetrics,
      TWindows & PreviousWindowMetrics<TMetric>
    >;
  }

  /**
   * Final result ordering — output keys (dimension/metric/window) order by
   * their projected alias, expressions verbatim; bare entries are
   * ascending, or wrap with {@link ascending}/{@link descending}.
   */
  orderBy(
    ...terms: readonly WindowOrderOperand<
      Extract<keyof TDimensions | keyof TMetrics | keyof TWindows, string>
    >[]
  ): AnalyticsQuery<TDimensions, TMetrics, TWindows> {
    if (terms.length === 0) {
      throw new OrmError("orderBy requires at least one term", {
        code: "ORM_INVALID_QUERY",
      });
    }
    return new AnalyticsQuery(this.#with({
      order: [...this.#state.order, ...terms],
    }));
  }

  /** Caps the result row count (binds as a parameter). */
  limit(
    count: number,
  ): AnalyticsQuery<TDimensions, TMetrics, TWindows> {
    if (!Number.isInteger(count) || count < 1) {
      throw new OrmError("limit must be a positive integer", {
        code: "ORM_INVALID_QUERY",
        details: { count },
      });
    }
    return new AnalyticsQuery(this.#with({ limitValue: count }));
  }

  /**
   * Compiles the query into one core `Sql` statement. Dimensions project
   * and group; metrics and windowed metrics project; window references
   * inline their aggregate expressions. Throws `ORM_INVALID_QUERY` when
   * nothing is declared.
   */
  toSql(): Sql {
    const state = this.#state;
    const dimensionKeys = Object.keys(state.dimensions);
    const projection: Record<string, unknown> = { ...state.dimensions };
    for (const [key, metric] of Object.entries(state.metrics)) {
      projection[key] = metric;
    }
    for (const [key, metric] of Object.entries(state.windows)) {
      projection[key] = compileWindowedMetric(state, metric);
    }
    if (Object.keys(projection).length === 0) {
      throw new OrmError(
        "Analytics query needs at least one dimension, metric, or window",
        { code: "ORM_INVALID_QUERY" },
      );
    }
    return assembleSelect({
      select: projection as SelectProjection,
      from: state.source,
      ...(state.condition === undefined ? {} : { where: state.condition }),
      ...(dimensionKeys.length > 0
        ? { groupBy: dimensionKeys.map((key) => state.dimensions[key]) }
        : {}),
      ...(state.order.length > 0
        ? {
          orderBy: state.order.map((term) => resolveQueryOrder(state, term)),
        }
        : {}),
      ...(state.limitValue === undefined ? {} : { limit: state.limitValue }),
    });
  }

  /**
   * Renders the compiled statement for a dialect identity — the dry-run
   * seam (`render({ dialect: "postgres" })` → `{ text, params }`).
   * Unsupported constructs throw the typed `ORM_DIALECT_UNSUPPORTED` error
   * here, before anything executes.
   */
  render(identity: SqlDialect | DialectIdentity): SqlQuery {
    const resolved = typeof identity === "string"
      ? { dialect: identity }
      : identity;
    return renderSql(this.toSql(), {
      dialect: resolved.dialect,
      ...(resolved.variant === undefined ? {} : { variant: resolved.variant }),
      ...(resolved.version === undefined ? {} : { version: resolved.version }),
    });
  }

  /**
   * Executes against any adapter `Database` (structurally — analytics never
   * imports one) and returns the typed rows the descriptor maps promise.
   * Rendering happens inside the executor with its detected identity, so an
   * unsupported construct fails with the typed capability error.
   */
  async execute(
    db: AnalyticsExecutor,
  ): Promise<readonly AnalyticsRow<TDimensions, TMetrics, TWindows>[]> {
    assertQuerySupported(this, db.dialectIdentity);
    const result = await db.execute<
      AnalyticsRow<TDimensions, TMetrics, TWindows>
    >(this.toSql());
    return result.rows;
  }
}

/**
 * Starts a typed analytical query over a source — a table/rollup definition
 * or a subquery fragment:
 *
 * ```ts
 * const rising = from(postHourlyStats)
 *   .where(gte(postHourlyStats.columns.bucket, since))
 *   .dimensions({
 *     postId: postHourlyStats.columns.postId,
 *     bucket: bucket("hour", postHourlyStats.columns.bucket),
 *   })
 *   .metrics({ votes: sum(postHourlyStats.columns.votes) })
 *   .windows({
 *     voteMa6h: movingAvg("votes", {
 *       partitionBy: ["postId"],
 *       orderBy: ["bucket"],
 *       rows: 6,
 *     }),
 *   })
 *   .orderBy(descending("voteMa6h"))
 *   .limit(50);
 * const rows = await rising.execute(db); // typed rows
 * ```
 */
export function from(source: AnalyticsSource): AnalyticsQuery {
  return AnalyticsQuery.create(source);
}
