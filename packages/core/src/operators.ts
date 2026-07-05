/**
 * Filter operators, ordering helpers, and aggregate expressions used to build
 * `Condition`s and projections (Drizzle-style `eq`/`and`/`inArray`/`count`).
 *
 * Part of `@sisal/core`; re-exported through `./mod.ts`.
 */

import { capabilityGuard, DIALECT_CAPABILITIES } from "./capabilities.ts";
import { OrmError } from "./errors.ts";
import {
  assertCondition,
  assertSubquery,
  columnToSql,
  type Condition,
  createCondition,
  dialectSql,
  expr,
  identifier,
  isColumn,
  isQueryBuilder,
  isSql,
  joinSql,
  operatorSql,
  type OrderTerm,
  raw,
  type Sql,
  sql,
  type SqlExpression,
  type SubquerySource,
  subquerySql,
} from "./sql.ts";

/** `column = value` SQL condition. */
export function eq(column: unknown, value: unknown): Condition {
  return binaryCondition(column, "=", value);
}

/** `column <> value` SQL condition. */
export function ne(column: unknown, value: unknown): Condition {
  return binaryCondition(column, "<>", value);
}

/** `column > value` SQL condition. */
export function gt(column: unknown, value: unknown): Condition {
  return binaryCondition(column, ">", value);
}

/** `column >= value` SQL condition. */
export function gte(column: unknown, value: unknown): Condition {
  return binaryCondition(column, ">=", value);
}

/** `column < value` SQL condition. */
export function lt(column: unknown, value: unknown): Condition {
  return binaryCondition(column, "<", value);
}

/** `column <= value` SQL condition. */
export function lte(column: unknown, value: unknown): Condition {
  return binaryCondition(column, "<=", value);
}

/** `column LIKE value` SQL condition. */
export function like(column: unknown, value: unknown): Condition {
  return binaryCondition(column, "like", value);
}

/**
 * Case-insensitive `ILIKE` match. Renders `ILIKE` on Postgres and degrades to
 * the (case-insensitive) `LIKE` on SQLite/libSQL/MySQL, which have no `ILIKE`.
 */
export function ilike(column: unknown, value: unknown): Condition {
  return operatorCondition(column, "ilike", value);
}

/** `column NOT LIKE value` SQL condition. */
export function notLike(column: unknown, value: unknown): Condition {
  return binaryCondition(column, "not like", value);
}

/** Case-insensitive `NOT ILIKE`; degrades to `NOT LIKE` off Postgres. */
export function notIlike(column: unknown, value: unknown): Condition {
  return operatorCondition(column, "not ilike", value);
}

/** `column BETWEEN min AND max` SQL condition (inclusive). */
export function between(
  column: unknown,
  min: unknown,
  max: unknown,
): Condition {
  return betweenCondition(column, min, max, false);
}

/** `column NOT BETWEEN min AND max` SQL condition. */
export function notBetween(
  column: unknown,
  min: unknown,
  max: unknown,
): Condition {
  return betweenCondition(column, min, max, true);
}

/**
 * `column IN (...)`. Each value is a bound parameter. An empty array yields a
 * constant always-false condition (`1 = 0`) rather than invalid `IN ()` SQL, so
 * dynamic filters with no values are safe. A select builder renders as a
 * subquery (`column IN (select ...)`).
 */
export function inArray(
  column: unknown,
  values: readonly unknown[] | SubquerySource,
): Condition {
  return inArrayCondition(column, values, false);
}

/**
 * `column NOT IN (...)`. An empty array yields a constant always-true condition;
 * a select builder renders as a subquery.
 */
export function notInArray(
  column: unknown,
  values: readonly unknown[] | SubquerySource,
): Condition {
  return inArrayCondition(column, values, true);
}

/** `column IS NULL` SQL condition. */
export function isNull(column: unknown): Condition {
  return createCondition(sql`${columnToSql(column)} is null`);
}

/** `column IS NOT NULL` SQL condition. */
export function isNotNull(column: unknown): Condition {
  return createCondition(sql`${columnToSql(column)} is not null`);
}

/** `EXISTS (subquery)` — true when the subquery returns any row. */
export function exists(subquery: SubquerySource): Condition {
  assertSubquery(subquery);
  return createCondition(sql`exists ${subquery}`);
}

/** `NOT EXISTS (subquery)` — true when the subquery returns no rows. */
export function notExists(subquery: SubquerySource): Condition {
  assertSubquery(subquery);
  return createCondition(sql`not exists ${subquery}`);
}

// The Postgres array operators render literally (`@>`/`<@`/`&&`); the
// registry capability makes rendering throw a typed `OrmError` on the SQLite
// family and MySQL (no array type/operators) instead of emitting SQL they
// reject. Each operator names itself as the guard's construct.
function arrayCondition(
  column: unknown,
  operator: string,
  value: unknown,
  construct: string,
): Condition {
  const right = isColumn(value) ? columnToSql(value) : value;
  return createCondition(
    sql`${capabilityGuard(DIALECT_CAPABILITIES.arrayOperators, construct)}${
      columnToSql(column)
    } ${raw(operator)} ${right}`,
  );
}

/**
 * Postgres array `@>` — true when `column` contains every element of `value`.
 * SQLite/libSQL have no array containment operator (rendering throws there).
 */
export function arrayContains(column: unknown, value: unknown): Condition {
  return arrayCondition(column, "@>", value, 'arrayContains ("@>")');
}

/** Postgres array `<@` — true when `column` is contained by `value`. */
export function arrayContained(column: unknown, value: unknown): Condition {
  return arrayCondition(column, "<@", value, 'arrayContained ("<@")');
}

/** Postgres array `&&` — true when `column` and `value` share any element. */
export function arrayOverlaps(column: unknown, value: unknown): Condition {
  return arrayCondition(column, "&&", value, 'arrayOverlaps ("&&")');
}

/** Combines conditions with SQL `AND`, ignoring nullish values. */
export function and(
  ...conditions: Array<Condition | null | undefined>
): Condition {
  return combineConditions("and", conditions);
}

/** Combines conditions with SQL `OR`, ignoring nullish values. */
export function or(
  ...conditions: Array<Condition | null | undefined>
): Condition {
  return combineConditions("or", conditions);
}

/** Negates a SQL condition with `NOT (...)`. */
export function not(condition: Condition): Condition {
  assertCondition(condition);
  return createCondition(sql`not (${condition.sql})`);
}

/**
 * The JS property key an order term carries, inferred from a table column
 * reference (falling back to `string` for raw operands/expressions).
 */
type OrderKey<TColumn> = TColumn extends { readonly propertyName: infer TKey }
  ? TKey extends string ? TKey : string
  : string;

/** Ascending order term for `orderBy`, e.g. `orderBy(asc(users.columns.name))`. */
export function asc<TColumn>(column: TColumn): OrderTerm<OrderKey<TColumn>> {
  return makeOrderTerm(column, "asc") as OrderTerm<OrderKey<TColumn>>;
}

/** Descending order term for `orderBy`, e.g. `orderBy(desc(users.columns.id))`. */
export function desc<TColumn>(column: TColumn): OrderTerm<OrderKey<TColumn>> {
  return makeOrderTerm(column, "desc") as OrderTerm<OrderKey<TColumn>>;
}

// An order term is a SQL fragment (so it renders in `orderBy`) that also carries
// the column and direction for keyset pagination to read.
function makeOrderTerm(column: unknown, direction: "asc" | "desc"): OrderTerm {
  const fragment = direction === "asc"
    ? sql`${columnToSql(column)} asc`
    : sql`${columnToSql(column)} desc`;
  return Object.freeze({
    kind: "sql",
    chunks: fragment.chunks,
    column,
    direction,
  }) as OrderTerm;
}

// Metadata attached to the aggregate fragments this module creates, so
// filter() can rebuild them as `agg(CASE WHEN … END)` for dialects without a
// native FILTER clause (MySQL/MariaDB — the v0.6 C5 probe). A WeakMap keeps
// the frozen fragments untouched and the public Sql surface unchanged (the
// RESULT_METADATA precedent); a fragment without metadata (a hand-written
// aggregate) simply has no CASE WHEN form and stays guarded under `mysql`.
interface AggregateMetadata {
  readonly fn: "count" | "sum" | "avg" | "min" | "max";
  /** Rendered operand; absent = `count(*)`'s argument-less form. */
  readonly operand?: Sql;
  readonly distinct?: boolean;
}
const AGGREGATE_METADATA = new WeakMap<Sql, AggregateMetadata>();

// Pre-rendered aggregate function names, so the CASE WHEN rebuild never
// interpolates a computed string into raw SQL.
const AGGREGATE_NAME: Record<AggregateMetadata["fn"], Sql> = {
  count: raw("count"),
  sum: raw("sum"),
  avg: raw("avg"),
  min: raw("min"),
  max: raw("max"),
};

function stampAggregate<T extends Sql>(
  fragment: T,
  metadata: AggregateMetadata,
): T {
  AGGREGATE_METADATA.set(fragment, metadata);
  return fragment;
}

/** `count(*)` (no argument) or `count(column)` aggregate expression. */
export function count(column?: unknown): SqlExpression<number> {
  if (column === undefined) {
    return stampAggregate(
      sql`count(${raw("*")})` as SqlExpression<number>,
      { fn: "count" },
    );
  }
  const operand = columnToSql(column);
  return stampAggregate(
    sql`count(${operand})` as SqlExpression<number>,
    { fn: "count", operand },
  );
}

/** `count(distinct column)` aggregate expression. */
export function countDistinct(column: unknown): SqlExpression<number> {
  const operand = columnToSql(column);
  return stampAggregate(
    sql`count(distinct ${operand})` as SqlExpression<number>,
    { fn: "count", operand, distinct: true },
  );
}

/** `sum(column)` aggregate expression. */
export function sum(column: unknown): SqlExpression<number | null> {
  const operand = columnToSql(column);
  return stampAggregate(
    sql`sum(${operand})` as SqlExpression<number | null>,
    { fn: "sum", operand },
  );
}

/** `avg(column)` aggregate expression. */
export function avg(column: unknown): SqlExpression<number | null> {
  const operand = columnToSql(column);
  return stampAggregate(
    sql`avg(${operand})` as SqlExpression<number | null>,
    { fn: "avg", operand },
  );
}

/** `min(column)` aggregate expression. */
export function min<T = unknown>(column: unknown): SqlExpression<T | null> {
  const operand = columnToSql(column);
  return stampAggregate(
    sql`min(${operand})` as SqlExpression<T | null>,
    { fn: "min", operand },
  );
}

/** `max(column)` aggregate expression. */
export function max<T = unknown>(column: unknown): SqlExpression<T | null> {
  const operand = columnToSql(column);
  return stampAggregate(
    sql`max(${operand})` as SqlExpression<T | null>,
    { fn: "max", operand },
  );
}

/**
 * Conditional aggregate: appends a `FILTER (WHERE …)` clause to an aggregate so
 * it only sees rows matching `condition` —
 * `filter(sum(score), gte(bucket, cutoff))` renders
 * `sum("score") filter (where "bucket" >= $1)`. Supported natively by
 * PostgreSQL and by modern SQLite/libSQL, so it renders identically on every
 * shipped Sisal adapter. Neither MySQL nor MariaDB has `FILTER` (v0.6 C5
 * probe), so under the `mysql` dialect the aggregate is rebuilt as the
 * equivalent `agg(CASE WHEN condition THEN operand END)` —
 * `count(*)` counts a literal `1`, `countDistinct` keeps its `DISTINCT` —
 * which non-matching rows enter as SQL `NULL` and every aggregate skips.
 * Only the aggregates this module exports carry the metadata that rebuild
 * needs; a hand-written `` sql`…` `` aggregate still throws a typed
 * `ORM_DIALECT_UNSUPPORTED` under `mysql`.
 */
export function filter<T>(
  aggregate: SqlExpression<T>,
  condition: Condition,
): SqlExpression<T> {
  assertCondition(condition);
  const native = sql`${aggregate} filter (where ${condition.sql})`;
  const metadata = AGGREGATE_METADATA.get(aggregate);
  if (metadata === undefined) {
    return dialectSql("filter (conditional aggregate)", {
      postgres: native,
      sqlite: native,
      generic: native,
    }) as SqlExpression<T>;
  }
  const name = AGGREGATE_NAME[metadata.fn];
  const operand = metadata.operand ?? raw("1");
  const caseForm = metadata.distinct === true
    ? sql`${name}(distinct case when ${condition.sql} then ${operand} end)`
    : sql`${name}(case when ${condition.sql} then ${operand} end)`;
  return dialectSql("filter (conditional aggregate)", {
    postgres: native,
    sqlite: native,
    generic: native,
    mysql: caseForm,
  }) as SqlExpression<T>;
}

/**
 * The upsert "proposed row" reference for `onConflictDoUpdate` `set` values,
 * rendered per dialect: `excluded."col"` on PostgreSQL and the SQLite family,
 * `values(` `` `col` `` `)` on MySQL — the one spelling every MySQL 5.7→9.x
 * and MariaDB accept (MySQL's 8.0.19+ row-alias form is a future
 * version-aware upgrade). Prefer this over a raw `` sql`excluded.col` ``: it
 * is the only portable spelling, and it maps the JS property key to the
 * physical column name under a naming strategy (`hotScore` → `hot_score`),
 * which the raw form silently gets wrong.
 */
export function excluded<T = unknown>(column: unknown): SqlExpression<T> {
  if (!isColumn(column)) {
    throw new OrmError("excluded() expects a table column", {
      code: "ORM_INVALID_COLUMN",
    });
  }
  const name = identifier(column.name);
  return dialectSql("excluded", {
    mysql: sql`values(${name})`,
  }, sql`excluded.${name}`) as SqlExpression<T>;
}

/** Calendar field a {@link dateTrunc} truncates a timestamp down to. */
export type DateTruncField =
  | "year"
  | "month"
  | "day"
  | "hour"
  | "minute"
  | "second";

// The per-field SQL literals, pre-quoted so they are passed to `raw()` as fixed
// constants (never interpolated, so no value can reach the SQL unparameterized).
// On Postgres the literal is the `date_trunc` unit; SQLite has no `date_trunc`,
// so the equivalent floors a timestamp with `strftime`, zeroing the finer
// fields. Both are ISO-8601, so values still sort and group identically.
const PG_DATE_TRUNC_UNIT: Record<DateTruncField, string> = {
  year: "'year'",
  month: "'month'",
  day: "'day'",
  hour: "'hour'",
  minute: "'minute'",
  second: "'second'",
};
const SQLITE_DATE_TRUNC_FORMAT: Record<DateTruncField, string> = {
  year: "'%Y-01-01 00:00:00'",
  month: "'%Y-%m-01 00:00:00'",
  day: "'%Y-%m-%d 00:00:00'",
  hour: "'%Y-%m-%d %H:00:00'",
  minute: "'%Y-%m-%d %H:%M:00'",
  second: "'%Y-%m-%d %H:%M:%S'",
};
// MySQL's DATE_FORMAT specifiers differ from strftime in exactly one place
// that matters here: minutes are `%i` (strftime `%M`).
const MYSQL_DATE_TRUNC_FORMAT: Record<DateTruncField, string> = {
  year: "'%Y-01-01 00:00:00'",
  month: "'%Y-%m-01 00:00:00'",
  day: "'%Y-%m-%d 00:00:00'",
  hour: "'%Y-%m-%d %H:00:00'",
  minute: "'%Y-%m-%d %H:%i:00'",
  second: "'%Y-%m-%d %H:%i:%s'",
};

/**
 * Portable timestamp truncation to a calendar `field`: renders
 * `date_trunc('<field>', src)` on PostgreSQL and the equivalent
 * `strftime('<format>', src)` on the SQLite family, so a time-bucket
 * `GROUP BY` reads the same on every adapter. `source` may be a column or any
 * SQL expression.
 *
 * **Round-trip:** PostgreSQL yields a `timestamp`; the SQLite family yields an
 * ISO-8601 `TEXT` string. Both order and group identically.
 */
export function dateTrunc(
  field: DateTruncField,
  source: unknown,
): SqlExpression<string> {
  const unit = PG_DATE_TRUNC_UNIT[field];
  const format = SQLITE_DATE_TRUNC_FORMAT[field];
  if (unit === undefined || format === undefined) {
    throw new OrmError(`Unknown dateTrunc field "${field}"`, {
      code: "ORM_INVALID_SQL",
      details: { field },
    });
  }
  const src = columnToSql(source);
  return dialectSql("dateTrunc", {
    postgres: sql`date_trunc(${raw(unit)}, ${src})`,
    sqlite: sql`strftime(${raw(format)}, ${src})`,
    mysql: sql`date_format(${src}, ${raw(MYSQL_DATE_TRUNC_FORMAT[field])})`,
  }) as SqlExpression<string>;
}

/**
 * The current timestamp, per dialect: `now()` on PostgreSQL,
 * `datetime('now')` on the SQLite family. Use it as the reference time for
 * moving-window predicates (`gte(col, dateSub(now(), { minutes: 15 }))`).
 */
export function now(): SqlExpression<string> {
  return dialectSql("now", {
    postgres: sql`now()`,
    sqlite: sql`datetime('now')`,
    mysql: sql`now(6)`,
  }) as SqlExpression<string>;
}

/**
 * A calendar/clock duration for {@link dateAdd} / {@link dateSub}. Every field
 * is optional; at least one must be non-zero. `years`/`months` are calendar
 * units (not a fixed number of seconds) and are rejected by {@link dateBin}.
 */
export interface DateDuration {
  /** Calendar years in the duration. */
  readonly years?: number;
  /** Calendar months in the duration. */
  readonly months?: number;
  /** Calendar days in the duration. */
  readonly days?: number;
  /** Clock hours in the duration. */
  readonly hours?: number;
  /** Clock minutes in the duration. */
  readonly minutes?: number;
  /** Clock seconds in the duration. */
  readonly seconds?: number;
}

const DURATION_UNITS = [
  "years",
  "months",
  "days",
  "hours",
  "minutes",
  "seconds",
] as const;

// MySQL INTERVAL unit keywords per duration unit (fixed enum, never user
// input, so it is safe inside raw()).
const MYSQL_INTERVAL_UNIT: Record<string, string> = {
  years: "year",
  months: "month",
  days: "day",
  hours: "hour",
  minutes: "minute",
  seconds: "second",
};

// The non-zero (unit, value) pairs of a duration, validated as finite numbers.
function durationParts(duration: DateDuration): Array<[string, number]> {
  const parts: Array<[string, number]> = [];
  for (const unit of DURATION_UNITS) {
    const value = duration[unit];
    if (value === undefined) continue;
    if (!Number.isFinite(value)) {
      throw new OrmError(`Invalid "${unit}" in duration`, {
        code: "ORM_INVALID_SQL",
        details: { unit, value },
      });
    }
    if (value !== 0) parts.push([unit, value]);
  }
  if (parts.length === 0) {
    throw new OrmError("Duration must have at least one non-zero unit", {
      code: "ORM_INVALID_SQL",
    });
  }
  return parts;
}

// `<source> ± interval` per dialect: PostgreSQL binds a compound interval
// literal as text and casts it (`$1::interval`); the SQLite family chains one
// signed `datetime(...)` modifier per unit. `source` should be a timestamp
// column or SQL expression (use `now()` for the current time); a SQLite-family
// result comes back as ISO-8601 `TEXT`.
function dateShift(
  source: unknown,
  duration: DateDuration,
  sign: 1 | -1,
): SqlExpression<string> {
  const parts = durationParts(duration);
  // PostgreSQL: one compound interval literal, e.g. "1 hours 30 minutes".
  const pgText = parts.map(([unit, value]) => `${value} ${unit}`).join(" ");
  const pg = sign < 0
    ? sql`${source} - ${pgText}::interval`
    : sql`${source} + ${pgText}::interval`;
  // SQLite: one signed modifier per unit, e.g. datetime(src, '-1 hours', …).
  let sqlite = sql`datetime(${source}`;
  for (const [unit, value] of parts) {
    const signed = sign * value;
    sqlite = sql`${sqlite}, ${`${signed >= 0 ? "+" : ""}${signed} ${unit}`}`;
  }
  sqlite = sql`${sqlite})`;
  // MySQL/MariaDB: nested DATE_ADD calls, one per unit, with the (signed)
  // quantity bound as a parameter and the unit keyword from a fixed enum.
  let mysql = sql`${source}`;
  for (const [unit, value] of parts) {
    const signed = sign * value;
    mysql = sql`date_add(${mysql}, interval ${signed} ${
      raw(MYSQL_INTERVAL_UNIT[unit])
    })`;
  }
  return dialectSql("dateShift", {
    postgres: pg,
    sqlite,
    mysql,
  }) as SqlExpression<string>;
}

/**
 * `source + duration`, rendered per dialect (`src + interval '…'` on
 * PostgreSQL; chained `datetime(src, '+…')` modifiers on the SQLite family).
 * `source` is a timestamp column or SQL expression — pass {@link now} for the
 * current time. A SQLite-family result is an ISO-8601 `TEXT` string.
 */
export function dateAdd(
  source: unknown,
  duration: DateDuration,
): SqlExpression<string> {
  return dateShift(source, duration, 1);
}

/**
 * `source - duration`, the mirror of {@link dateAdd} — the building block for
 * moving-window predicates, e.g.
 * `gte(col, dateSub(now(), { minutes: 15 }))`.
 */
export function dateSub(
  source: unknown,
  duration: DateDuration,
): SqlExpression<string> {
  return dateShift(source, duration, -1);
}

// Seconds per fixed-width unit. `years`/`months` are absent: they have no fixed
// length, so {@link dateBin} rejects them.
const BIN_UNIT_SECONDS: Record<string, number> = {
  days: 86400,
  hours: 3600,
  minutes: 60,
  seconds: 1,
};

/**
 * Floors `source` to the start of its `every`-wide time bucket — the portable
 * arbitrary-interval bucket (e.g. 5-minute buckets) that `dateTrunc`'s fixed
 * calendar fields can't express. Renders
 * `to_timestamp(floor(extract(epoch from src) / N) * N)` on PostgreSQL and
 * `datetime((unixepoch(src) / N) * N, 'unixepoch')` on the SQLite family, where
 * `N` is `every` in seconds.
 *
 * `every` must use only fixed-width units (`days`/`hours`/`minutes`/`seconds`)
 * summing to a positive whole number of seconds; `years`/`months` throw.
 * `source` should be a timestamp column or SQL expression. **Round-trip:**
 * PostgreSQL yields a `timestamp`; the SQLite family yields ISO-8601 `TEXT`.
 */
export function dateBin(
  every: DateDuration,
  source: unknown,
): SqlExpression<string> {
  let seconds = 0;
  for (const [unit, value] of durationParts(every)) {
    const perUnit = BIN_UNIT_SECONDS[unit];
    if (perUnit === undefined) {
      throw new OrmError(
        `dateBin does not support the calendar unit "${unit}"`,
        { code: "ORM_INVALID_SQL", details: { unit } },
      );
    }
    seconds += value * perUnit;
  }
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new OrmError(
      "dateBin interval must be a positive whole second count",
      {
        code: "ORM_INVALID_SQL",
        details: { seconds },
      },
    );
  }
  // `seconds` is a validated positive integer, so it is safe to inline as a SQL
  // literal (it can never carry user input or break integer division).
  const n = raw(String(seconds));
  const src = columnToSql(source);
  return dialectSql("dateBin", {
    postgres:
      sql`to_timestamp(floor(extract(epoch from ${src}) / ${n}) * ${n})`,
    sqlite: sql`datetime((unixepoch(${src}) / ${n}) * ${n}, 'unixepoch')`,
    mysql: sql`from_unixtime(floor(unix_timestamp(${src}) / ${n}) * ${n})`,
  }) as SqlExpression<string>;
}

// A scalar-function operand: columns/expressions render as SQL, anything
// else binds as a parameter (the binaryCondition rule for argument lists).
function operandSql(value: unknown): Sql {
  return isColumn(value) || isSql(value) ? columnToSql(value) : sql`${value}`;
}

/**
 * `coalesce(a, b, …)` — the first non-null operand. Portable across all four
 * dialects; columns and expressions render as SQL, plain values bind as
 * parameters. Retires the last raw seam in the composed ETL rollups
 * (v0.8 item 9).
 */
export function coalesce<T = unknown>(
  ...values: readonly unknown[]
): SqlExpression<T> {
  if (values.length < 2) {
    throw new OrmError("coalesce requires at least two operands", {
      code: "ORM_INVALID_QUERY",
    });
  }
  return expr<T>(
    sql`coalesce(${joinSql(values.map(operandSql), raw(", "))})`,
  );
}

// greatest/least render natively on PostgreSQL and the MySQL family; the
// SQLite family spells them as the multi-argument scalar max()/min(). NULL
// semantics diverge across engines (PostgreSQL ignores NULL operands;
// MySQL/MariaDB and SQLite return NULL when any operand is NULL) — pass
// coalesce()d operands when NULLs are possible.
function extremumSql(
  construct: "greatest" | "least",
  sqliteName: "max" | "min",
  values: readonly unknown[],
): Sql {
  if (values.length < 2) {
    throw new OrmError(`${construct} requires at least two operands`, {
      code: "ORM_INVALID_QUERY",
    });
  }
  const operands = joinSql(values.map(operandSql), raw(", "));
  return dialectSql(construct, {
    postgres: sql`${raw(construct)}(${operands})`,
    mysql: sql`${raw(construct)}(${operands})`,
    generic: sql`${raw(construct)}(${operands})`,
    sqlite: sql`${raw(sqliteName)}(${operands})`,
  });
}

/**
 * `greatest(a, b, …)` — the largest operand (SQLite renders the scalar
 * `max(a, b, …)`). NULL handling diverges per engine: PostgreSQL ignores
 * NULLs, MySQL/MariaDB and SQLite return NULL if any operand is NULL — wrap
 * operands in {@link coalesce} when they can be NULL.
 */
export function greatest<T = unknown>(
  ...values: readonly unknown[]
): SqlExpression<T> {
  return expr<T>(extremumSql("greatest", "max", values));
}

/**
 * `least(a, b, …)` — the smallest operand (SQLite renders the scalar
 * `min(a, b, …)`). The same per-engine NULL divergence as {@link greatest}
 * applies.
 */
export function least<T = unknown>(
  ...values: readonly unknown[]
): SqlExpression<T> {
  return expr<T>(extremumSql("least", "min", values));
}

/** Whole-unit fields accepted by {@link dateDiff}. */
export type DateDiffField = "seconds" | "minutes" | "hours" | "days";

const DATE_DIFF_SECONDS: Record<DateDiffField, number> = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
  days: 86400,
};

// The MySQL TIMESTAMPDIFF unit keyword per field — fixed keywords, never
// interpolated from input.
const DATE_DIFF_MYSQL_UNIT: Record<DateDiffField, Sql> = {
  seconds: raw("second"),
  minutes: raw("minute"),
  hours: raw("hour"),
  days: raw("day"),
};

/**
 * Whole units elapsed from `from` to `to` (truncated toward zero, matching
 * MySQL's `TIMESTAMPDIFF`) — the portable date-diff/gap helper the
 * sessionization and cohort contracts need (v0.8 item 10):
 * PostgreSQL `trunc(extract(epoch from (to - from)) / N)`, MySQL family
 * `timestampdiff(unit, from, to)`, SQLite
 * `cast((julianday(to) - julianday(from)) * 86400.0 / N as integer)`.
 * Positive when `to` is later than `from`.
 */
export function dateDiff(
  field: DateDiffField,
  from: unknown,
  to: unknown,
): SqlExpression<number> {
  const seconds = DATE_DIFF_SECONDS[field];
  if (seconds === undefined) {
    throw new OrmError("dateDiff field must be seconds|minutes|hours|days", {
      code: "ORM_INVALID_SQL",
      details: { field },
    });
  }
  // Validated positive integers from the fixed table above — safe to inline.
  const n = raw(String(seconds));
  const a = operandSql(from);
  const b = operandSql(to);
  return dialectSql("dateDiff", {
    postgres: sql`trunc(extract(epoch from (${b} - ${a})) / ${n})`,
    mysql: sql`timestampdiff(${DATE_DIFF_MYSQL_UNIT[field]}, ${a}, ${b})`,
    sqlite:
      sql`cast((julianday(${b}) - julianday(${a})) * 86400.0 / ${n} as integer)`,
  }) as SqlExpression<number>;
}

function binaryCondition(
  column: unknown,
  operator: string,
  value: unknown,
): Condition {
  // A column value renders as a column reference (e.g. join `ON a.x = b.y`);
  // anything else is bound as a parameter.
  const right = isColumn(value) ? columnToSql(value) : value;
  return createCondition(sql`${columnToSql(column)} ${raw(operator)} ${right}`);
}

// Like binaryCondition, but the operator is rendered per dialect (see
// renderOperator) — used by ilike/notIlike.
function operatorCondition(
  column: unknown,
  operator: string,
  value: unknown,
): Condition {
  const right = isColumn(value) ? columnToSql(value) : value;
  return createCondition(
    sql`${columnToSql(column)} ${operatorSql(operator)} ${right}`,
  );
}

function betweenCondition(
  column: unknown,
  min: unknown,
  max: unknown,
  negated: boolean,
): Condition {
  // Bounds render as column references when given columns, else bound params.
  const lower = isColumn(min) ? columnToSql(min) : min;
  const upper = isColumn(max) ? columnToSql(max) : max;
  return createCondition(
    sql`${columnToSql(column)} ${
      raw(negated ? "not between" : "between")
    } ${lower} and ${upper}`,
  );
}

function inArrayCondition(
  column: unknown,
  values: readonly unknown[] | SubquerySource,
  negated: boolean,
): Condition {
  if (isQueryBuilder(values)) {
    return createCondition(
      sql`${columnToSql(column)} ${raw(negated ? "not in" : "in")} ${
        subquerySql(values)
      }`,
    );
  }

  if (!Array.isArray(values)) {
    throw new OrmError("inArray requires an array of values", {
      code: "ORM_INVALID_QUERY",
    });
  }

  if (values.length === 0) {
    return createCondition(raw(negated ? "1 = 1" : "1 = 0"));
  }

  const list = joinSql(
    values.map((value) => sql`${value}`),
    raw(", "),
  );

  return createCondition(
    sql`${columnToSql(column)} ${raw(negated ? "not in" : "in")} (${list})`,
  );
}

function combineConditions(
  operator: "and" | "or",
  conditions: Array<Condition | null | undefined>,
): Condition {
  const validConditions = conditions.filter((
    condition,
  ): condition is Condition => condition !== undefined && condition !== null);

  if (validConditions.length === 0) {
    throw new OrmError("At least one condition is required", {
      code: "ORM_INVALID_QUERY",
      details: { operator },
    });
  }

  if (validConditions.length === 1) {
    return validConditions[0];
  }

  return createCondition(
    joinSql(
      validConditions.map((condition) => sql`(${condition.sql})`),
      // operator is a fixed SQL keyword (and/or), never user input.
      // deno-lint-ignore sisal/no-raw-interpolation
      raw(` ${operator} `),
    ),
  );
}
