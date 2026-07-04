/**
 * Capability-gating for analytical queries: {@link supportsQuery} /
 * {@link assertQuerySupported} decide **before anything executes** whether a
 * query's shape renders on a given engine identity — and when it does not,
 * the answer is a typed `ANALYTICS_UNSUPPORTED_QUERY` refusal naming the
 * construct, never a raw engine error or silently different SQL.
 *
 * The gate is a render probe (the ETL v0.10 pattern): the query compiles and
 * renders for the exact `(dialect, variant, version)` identity, so every
 * render-time guard in the core IR — a `GROUPS` frame, a percentile
 * aggregate, a MariaDB `lag()` default — is exercised up front. PostgreSQL
 * is the first-class target; other engines run exactly the subset their
 * renderer accepts.
 *
 * @module
 */

import { OrmError, renderSql } from "@sisal/core";
import type { DialectIdentity, SqlDialect } from "@sisal/core";
import type { AnalyticsQuery } from "./query.ts";

/** The verdict returned by {@link supportsQuery}. */
export type AnalyticsQuerySupport =
  | {
    /** The query's exact SQL renders on this identity. */
    readonly supported: true;
  }
  | {
    /** The query cannot run on this identity. */
    readonly supported: false;
    /** Why — the construct the identity's renderer refused. */
    readonly reason: string;
  };

function normalizeIdentity(
  identity: SqlDialect | DialectIdentity,
): DialectIdentity {
  return typeof identity === "string" ? { dialect: identity } : identity;
}

function describeIdentity(identity: DialectIdentity): string {
  const variant = identity.variant === undefined ? "" : `/${identity.variant}`;
  const version = identity.version === undefined ? "" : ` ${identity.version}`;
  return `${identity.dialect}${variant}${version}`;
}

/**
 * Decides whether `query` renders on the engine `identity` (a bare dialect
 * or the full `db.dialectIdentity`), without executing anything. Returns
 * `{ supported: false, reason }` when the query contains a construct the
 * identity's renderer refuses; the reason names the construct.
 */
export function supportsQuery(
  // deno-lint-ignore no-explicit-any
  query: AnalyticsQuery<any, any, any>,
  identity: SqlDialect | DialectIdentity,
): AnalyticsQuerySupport {
  const resolved = normalizeIdentity(identity);
  try {
    renderSql(query.toSql(), {
      dialect: resolved.dialect,
      ...(resolved.variant === undefined ? {} : { variant: resolved.variant }),
      ...(resolved.version === undefined ? {} : { version: resolved.version }),
    });
  } catch (error) {
    if (
      error instanceof OrmError && error.code === "ORM_DIALECT_UNSUPPORTED"
    ) {
      return { supported: false, reason: error.message };
    }
    throw error;
  }
  return { supported: true };
}

/**
 * The throwing form of {@link supportsQuery}: refuses an unsupported query
 * shape with the typed `ANALYTICS_UNSUPPORTED_QUERY` error (status 400,
 * details carrying the identity and reason) — call it pre-flight when a
 * raw `ORM_DIALECT_UNSUPPORTED` render error mid-request would be too late.
 */
export function assertQuerySupported(
  // deno-lint-ignore no-explicit-any
  query: AnalyticsQuery<any, any, any>,
  identity: SqlDialect | DialectIdentity,
): void {
  const resolved = normalizeIdentity(identity);
  const support = supportsQuery(query, resolved);
  if (support.supported) {
    return;
  }
  throw new OrmError(
    `Analytics query is not supported on ${describeIdentity(resolved)}: ` +
      support.reason,
    {
      code: "ANALYTICS_UNSUPPORTED_QUERY",
      status: 400,
      details: {
        dialect: resolved.dialect,
        ...(resolved.variant === undefined
          ? {}
          : { variant: resolved.variant }),
        ...(resolved.version === undefined
          ? {}
          : { version: resolved.version }),
        reason: support.reason,
      },
    },
  );
}
