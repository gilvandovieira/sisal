/**
 * Window-function expression primitives — the minimal core seam the v0.7 A3
 * decision reserved and v0.8 item 10 ships: `over()` attaches a
 * partition/order/frame {@link WindowSpec} to any expression, and the bare
 * window functions (`rank`/`denseRank`/`rowNumber`/`lag`/`lead`) are typed
 * grammar-level expressions. The rich metric/dimension/named-window API stays
 * in the future `@sisal/analytics` package.
 *
 * All supported engines at Sisal's version floors render window functions
 * (PostgreSQL, MySQL ≥ 8.0.16, MariaDB ≥ 10.10, SQLite ≥ 3.25) with `ROWS`
 * and `RANGE` frames; `GROUPS` frames are PostgreSQL-first (the MySQL family
 * has none; SQLite needs 3.28+, version-gated fail-closed).
 *
 * @module
 */

import { capabilityGuard, DIALECT_CAPABILITIES } from "./capabilities.ts";
import { OrmError } from "./errors.ts";
import {
  columnToSql,
  emptySql,
  expr,
  isOrderTerm,
  joinSql,
  raw,
  type Sql,
  sql,
  type SqlExpression,
} from "./sql.ts";

/**
 * One edge of a {@link WindowFrame}: the frame keywords, or an offset of
 * `n` rows/values before or after the current row (a validated non-negative
 * integer — engines do not accept bound parameters in frame clauses, so the
 * offset renders inline).
 */
export type FrameBound =
  | "unboundedPreceding"
  | "unboundedFollowing"
  | "currentRow"
  | { readonly preceding: number }
  | { readonly following: number };

/** A window frame clause: `ROWS`/`RANGE`/`GROUPS BETWEEN start AND end`. */
export interface WindowFrame {
  /** Frame unit; `"groups"` is capability-gated (PostgreSQL-first). */
  readonly unit: "rows" | "range" | "groups";
  /** Closes resources held by this window frame. */
  readonly start: FrameBound;
  /** Closes resources held by this window frame. */
  readonly end: FrameBound;
}

/**
 * The window specification `over()` renders: partition keys, ordering terms
 * (`asc()`/`desc()` or bare columns/expressions), and an optional frame.
 */
export interface WindowSpec {
  /** Expressions that partition rows before the window function runs. */
  readonly partitionBy?: readonly unknown[];
  /** Expressions that order rows within each partition. */
  readonly orderBy?: readonly unknown[];
  /** Optional frame bounds for the ordered window. */
  readonly frame?: WindowFrame;
}

function frameBoundSql(bound: FrameBound): Sql {
  if (bound === "unboundedPreceding") {
    return raw("unbounded preceding");
  }
  if (bound === "unboundedFollowing") {
    return raw("unbounded following");
  }
  if (bound === "currentRow") {
    return raw("current row");
  }
  const [offset, keyword] = "preceding" in bound
    ? [bound.preceding, raw(" preceding")]
    : [bound.following, raw(" following")];
  if (!Number.isInteger(offset) || offset < 0) {
    throw new OrmError("window frame offset must be a non-negative integer", {
      code: "ORM_INVALID_SQL",
      details: { offset },
    });
  }
  // Validated non-negative integer — safe to inline (frame clauses reject
  // bound parameters on every engine).
  return joinSql([raw(String(offset)), keyword], emptySql());
}

// Fixed frame-unit keywords — never interpolated from input.
const FRAME_UNIT: Record<WindowFrame["unit"], Sql> = {
  rows: raw("rows between "),
  range: raw("range between "),
  groups: raw("groups between "),
};

function frameSql(frame: WindowFrame): Sql {
  const unit = FRAME_UNIT[frame.unit];
  if (unit === undefined) {
    throw new OrmError("window frame unit must be rows|range|groups", {
      code: "ORM_INVALID_SQL",
      details: { unit: frame.unit },
    });
  }
  const parts: Sql[] = [];
  if (frame.unit === "groups") {
    parts.push(capabilityGuard(DIALECT_CAPABILITIES.windowGroupsFrame));
  }
  parts.push(
    unit,
    frameBoundSql(frame.start),
    raw(" and "),
    frameBoundSql(frame.end),
  );
  return joinSql(parts, emptySql());
}

/**
 * Attaches an `OVER (…)` window to an expression —
 * `over(avg(score), { partitionBy: [c.community], orderBy: [asc(c.bucket)],
 * frame: { unit: "rows", start: { preceding: 5 }, end: "currentRow" } })`.
 * The expression keeps its inferred type. An empty spec renders `over ()`.
 */
export function over<T>(
  expression: SqlExpression<T>,
  spec: WindowSpec = {},
): SqlExpression<T> {
  const clauses: Sql[] = [];
  if (spec.partitionBy !== undefined && spec.partitionBy.length > 0) {
    clauses.push(
      sql`partition by ${
        joinSql(
          spec.partitionBy.map((column) => columnToSql(column)),
          raw(", "),
        )
      }`,
    );
  }
  if (spec.orderBy !== undefined && spec.orderBy.length > 0) {
    clauses.push(sql`order by ${
      joinSql(
        spec.orderBy.map((term) =>
          isOrderTerm(term) ? term : columnToSql(term)
        ),
        raw(", "),
      )
    }`);
  }
  if (spec.frame !== undefined) {
    clauses.push(frameSql(spec.frame));
  }
  return expr<T>(
    sql`${expression} over (${joinSql(clauses, raw(" "))})`,
  );
}

/**
 * `rank()` — window-only ranking with gaps. Must be wrapped in
 * {@link over}; engines reject it without an `OVER` clause.
 */
export function rank(): SqlExpression<number> {
  return expr<number>(sql`rank()`);
}

/** `dense_rank()` — window-only ranking without gaps. Wrap in {@link over}. */
export function denseRank(): SqlExpression<number> {
  return expr<number>(sql`dense_rank()`);
}

/** `row_number()` — window-only row numbering. Wrap in {@link over}. */
export function rowNumber(): SqlExpression<number> {
  return expr<number>(sql`row_number()`);
}

function offsetFunction<T>(
  name: "lag" | "lead",
  column: unknown,
  offset: number,
  defaultValue: unknown,
): SqlExpression<T | null> {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new OrmError(`${name} offset must be a non-negative integer`, {
      code: "ORM_INVALID_SQL",
      details: { offset },
    });
  }
  const operand = columnToSql(column);
  // The validated integer offset renders inline; a default value binds as a
  // parameter (or renders as SQL when it is a column/expression). MariaDB's
  // parser rejects the default argument (live-verified on 11.8.8), so it is
  // capability-guarded there — spell it `coalesce(over(lag(x), …), default)`
  // for MariaDB portability.
  const parts: Sql[] = [operand, sql`, ${raw(String(offset))}`];
  if (defaultValue !== undefined) {
    parts.push(
      sql`${
        capabilityGuard(DIALECT_CAPABILITIES.windowOffsetDefault)
      }, ${defaultValue}`,
    );
  }
  return expr<T | null>(
    sql`${raw(name)}(${joinSql(parts, emptySql())})`,
  );
}

/**
 * `lag(column, offset = 1, default?)` — the value `offset` rows before the
 * current row in the window order (NULL — or `default` — outside the
 * partition). Window-only: wrap in {@link over}.
 */
export function lag<T = unknown>(
  column: unknown,
  offset = 1,
  defaultValue?: unknown,
): SqlExpression<T | null> {
  return offsetFunction<T>("lag", column, offset, defaultValue);
}

/**
 * `lead(column, offset = 1, default?)` — the value `offset` rows after the
 * current row in the window order. Window-only: wrap in {@link over}.
 */
export function lead<T = unknown>(
  column: unknown,
  offset = 1,
  defaultValue?: unknown,
): SqlExpression<T | null> {
  return offsetFunction<T>("lead", column, offset, defaultValue);
}
