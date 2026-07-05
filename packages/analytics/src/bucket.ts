/**
 * Time-bucket dimensions: {@link bucket} floors a timestamp to a calendar
 * grain (via the portable `dateTrunc`) or to an arbitrary fixed-width
 * interval (via `dateBin`), and marks the expression as the query's **time
 * dimension** so `compareToPreviousWindow()` can find the period axis
 * without being told.
 *
 * Round-trip: analytics buckets are projected as text on every supported SQL
 * family. PostgreSQL wraps the core timestamp bucket in `to_char(...)`, while
 * SQLite and MySQL already render text buckets. All order and group
 * identically because the format is most-significant component first.
 *
 * @module
 */

import { dateBin, dateTrunc, dialectSql, raw, sql } from "@sisal/core";
import type { DateDuration, DateTruncField, SqlExpression } from "@sisal/core";

// Expressions minted by bucket(), so compareToPreviousWindow() can recognize
// the query's time dimension by identity. A WeakSet keeps core's frozen Sql
// objects untouched.
const TIME_BUCKETS = new WeakSet<object>();

/**
 * A time-bucket dimension: `bucket("hour", stats.columns.bucket)` floors to
 * a calendar grain, `bucket({ minutes: 5 }, …)` to a fixed-width interval.
 * Use it as a dimension value; it groups, projects, and orders like any
 * expression, and marks the query's time axis for
 * `compareToPreviousWindow()`.
 */
export function bucket(
  width: DateTruncField | DateDuration,
  source: unknown,
): SqlExpression<string> {
  const expression = typeof width === "string"
    ? dateTrunc(width, source)
    : dateBin(width, source);
  const textBucket = dialectSql("analyticsBucket", {
    postgres: sql`to_char(${expression}, ${raw("'YYYY-MM-DD HH24:MI:SS'")})`,
    sqlite: expression,
    mysql: expression,
  }) as SqlExpression<string>;
  TIME_BUCKETS.add(textBucket);
  return textBucket;
}

/** Returns true when a dimension value was produced by {@link bucket}. */
export function isTimeBucket(value: unknown): boolean {
  return typeof value === "object" && value !== null &&
    TIME_BUCKETS.has(value);
}
