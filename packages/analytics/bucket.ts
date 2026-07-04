/**
 * Time-bucket dimensions: {@link bucket} floors a timestamp to a calendar
 * grain (via the portable `dateTrunc`) or to an arbitrary fixed-width
 * interval (via `dateBin`), and marks the expression as the query's **time
 * dimension** so `compareToPreviousWindow()` can find the period axis
 * without being told.
 *
 * Round-trip: PostgreSQL yields a `timestamp`; the SQLite family yields
 * ISO-8601 `TEXT`; MySQL yields formatted text. All order and group
 * identically — the row type is `string`.
 *
 * @module
 */

import { dateBin, dateTrunc } from "@sisal/core";
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
  TIME_BUCKETS.add(expression);
  return expression;
}

/** Returns true when a dimension value was produced by {@link bucket}. */
export function isTimeBucket(value: unknown): boolean {
  return typeof value === "object" && value !== null &&
    TIME_BUCKETS.has(value);
}
