/**
 * Capability-gating for ETL jobs (v0.10 T21): {@link supportsJob} /
 * {@link assertJobSupported} decide **before anything executes** whether a
 * job's shape runs on a given engine identity — and when it does not, the
 * answer is a typed `ETL_UNSUPPORTED_JOB` refusal, **never a
 * silently-degraded runner**.
 *
 * The gate has two layers:
 *
 * 1. **Engine allowlist** — the runner needs the portable advisory lock and
 *    the checkpoint substrate, which exist on `postgres`, `sqlite`, and
 *    `mysql` ({@link ETL_DIALECTS}); the driverless `generic` dialect fails
 *    closed. Neon and libSQL/Turso are the `postgres`/`sqlite` dialects with
 *    an adapter-detected identity; MariaDB is the `mysql` dialect with the
 *    `mariadb` variant.
 * 2. **Render probe** — the job's rollup is compiled and rendered for the
 *    exact `(dialect, variant, version)` identity, so every render-time
 *    dialect guard in the core IR (a `FILTER` fallback, a version-gated
 *    construct, a postgres-only expression in an aggregate) is exercised
 *    up front. What would fail mid-run instead refuses pre-flight.
 *
 * PostgreSQL is the first-class target; other engines run exactly the subset
 * their renderer accepts. Part of the `@sisal/core`-only compile tier.
 *
 * @module
 */

import { OrmError, renderSql } from "@sisal/core";
import type { DialectIdentity, SqlDialect } from "@sisal/core";
import type { EtlJob } from "./job.ts";
import { rollup } from "./rollup.ts";

/**
 * The dialects the ETL runtime supports — the engines carrying both the
 * portable advisory lock and the checkpoint substrate. The `generic` dialect
 * fails closed.
 */
export const ETL_DIALECTS = ["postgres", "sqlite", "mysql"] as const;

/** The verdict returned by {@link supportsJob}. */
export type EtlJobSupport =
  | {
    /** The job's exact SQL renders on this identity. */
    readonly supported: true;
  }
  | {
    /** The job cannot run on this identity. */
    readonly supported: false;
    /** Why — the engine gap or the construct the renderer refused. */
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

// Any valid half-open window works for the probe — the render is
// window-value-independent (bounds bind as parameters).
const PROBE_WINDOW = {
  from: "2026-01-01T00:00:00.000Z",
  until: "2026-01-01T01:00:00.000Z",
};

/**
 * Decides whether `job` runs on the engine `identity` (a bare dialect or the
 * full `db.dialectIdentity`), without executing anything. Returns
 * `{ supported: false, reason }` when the engine lacks the ETL substrate or
 * when the job's generated SQL contains a construct the identity's renderer
 * refuses; the reason names the gap.
 */
export function supportsJob(
  job: EtlJob,
  identity: SqlDialect | DialectIdentity,
): EtlJobSupport {
  const resolved = normalizeIdentity(identity);
  if (!(ETL_DIALECTS as readonly string[]).includes(resolved.dialect)) {
    return {
      supported: false,
      reason: `the "${resolved.dialect}" dialect has no ETL lock/checkpoint ` +
        `substrate (supported: ${ETL_DIALECTS.join(", ")})`,
    };
  }
  try {
    renderSql(rollup(job, PROBE_WINDOW), {
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
 * The throwing form of {@link supportsJob}: refuses an unsupported job shape
 * with the typed `ETL_UNSUPPORTED_JOB` error (status 400, details carrying
 * the job, identity, and reason). The runner calls this **pre-flight** —
 * before the lock, the checkpoint, and the SQL — so an unsupported job never
 * partially executes and never silently degrades.
 */
export function assertJobSupported(
  job: EtlJob,
  identity: SqlDialect | DialectIdentity,
): void {
  const resolved = normalizeIdentity(identity);
  const support = supportsJob(job, resolved);
  if (support.supported) {
    return;
  }
  throw new OrmError(
    `ETL job "${job.name}" is not supported on ` +
      `${describeIdentity(resolved)}: ${support.reason}`,
    {
      code: "ETL_UNSUPPORTED_JOB",
      status: 400,
      details: {
        job: job.name,
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
