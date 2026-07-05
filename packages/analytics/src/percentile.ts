/**
 * Percentile metrics — **experimental, Postgres-first** (the v0.11 roadmap's
 * percentile investigation). `percentile_cont`/`percentile_disc` are
 * ordered-set aggregates with no SQLite-family equivalent and a different
 * (window-function) grammar on MariaDB, so both helpers are capability-gated:
 * rendering them on a non-PostgreSQL identity throws the typed
 * `ORM_DIALECT_UNSUPPORTED` error instead of reaching the engine.
 *
 * @module
 */

import {
  capabilityGuard,
  DIALECT_CAPABILITIES,
  expr,
  OrmError,
  sql,
} from "@sisal/core";
import type { SqlExpression } from "@sisal/core";

function assertFraction(name: string, fraction: number): void {
  if (typeof fraction !== "number" || !(fraction >= 0 && fraction <= 1)) {
    throw new OrmError(`${name} fraction must be a number in [0, 1]`, {
      code: "ORM_INVALID_QUERY",
      details: { fraction },
    });
  }
}

/**
 * Continuous percentile — `percentile_cont(fraction) within group
 * (order by source)`, interpolating between adjacent values:
 * `percentileCont(0.5, stats.columns.score)` is the median. PostgreSQL-only
 * (capability-gated); nullable — an empty group yields NULL.
 */
export function percentileCont(
  fraction: number,
  source: unknown,
): SqlExpression<number | null> {
  assertFraction("percentileCont", fraction);
  return expr<number | null>(
    sql`${
      capabilityGuard(DIALECT_CAPABILITIES.percentileAggregates)
    }percentile_cont(${fraction}) within group (order by ${source})`,
  );
}

/**
 * Discrete percentile — `percentile_disc(fraction) within group
 * (order by source)`, returning an actual input value (no interpolation),
 * so the result carries the source column's value type. PostgreSQL-only
 * (capability-gated); nullable.
 */
export function percentileDisc<T = unknown>(
  fraction: number,
  source: unknown,
): SqlExpression<T | null> {
  assertFraction("percentileDisc", fraction);
  return expr<T | null>(
    sql`${
      capabilityGuard(DIALECT_CAPABILITIES.percentileAggregates)
    }percentile_disc(${fraction}) within group (order by ${source})`,
  );
}
