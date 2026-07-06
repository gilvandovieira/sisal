/**
 * Analytics aggregate helpers exposed through the `@sisal/analytics` boundary.
 *
 * These delegate to `@sisal/core` so analytical queries share the same SQL IR
 * and dialect capability behavior as the rest of Sisal, while keeping the
 * public declarations documented as analytics API.
 *
 * @module
 */

import {
  avg as coreAvg,
  count as coreCount,
  countDistinct as coreCountDistinct,
  max as coreMax,
  min as coreMin,
  type SqlExpression,
  sum as coreSum,
} from "@sisal/core";

/** `count(*)` or `count(column)` aggregate expression for analytics metrics. */
export function count(column?: unknown): SqlExpression<number> {
  return coreCount(column);
}

/** `count(distinct column)` aggregate expression for analytics metrics. */
export function countDistinct(column: unknown): SqlExpression<number> {
  return coreCountDistinct(column);
}

/** `sum(column)` aggregate expression for analytics metrics. */
export function sum(column: unknown): SqlExpression<number | null> {
  return coreSum(column);
}

/** `avg(column)` aggregate expression for analytics metrics. */
export function avg(column: unknown): SqlExpression<number | null> {
  return coreAvg(column);
}

/** `min(column)` aggregate expression for analytics metrics. */
export function min<T = unknown>(column: unknown): SqlExpression<T | null> {
  return coreMin<T>(column);
}

/** `max(column)` aggregate expression for analytics metrics. */
export function max<T = unknown>(column: unknown): SqlExpression<T | null> {
  return coreMax<T>(column);
}
