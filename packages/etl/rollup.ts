/**
 * The generated pushdown rollup (v0.10 T13): {@link rollup} compiles a
 * validated {@link EtlJob} plus one half-open window into a **single**
 * insert-from-select statement — `dateTrunc` bucket + group keys + aggregate
 * expressions, filtered to `[from, until)`, upserted with
 * `ON CONFLICT ... DO UPDATE` keyed on the grain (bucket + group keys) so a
 * re-run of the same window overwrites rather than double-counts.
 *
 * Compilation is pure `@sisal/core` assembly (`assembleInsertFromSelect`) —
 * no connection, no builder state — so the exact SQL can be rendered for
 * dry-run/explain and pinned by golden tests, and the runner can hand the
 * fragment to `db.batch` unchanged. The database does the scan, group,
 * aggregate, and upsert; no row ever round-trips through the runner.
 *
 * @module
 */

import {
  and,
  assembleInsertFromSelect,
  dateTrunc,
  excluded,
  gte,
  lt,
  OrmError,
  renderSql,
} from "@sisal/core";
import type { Sql, SqlDialect, SqlQuery } from "@sisal/core";
import type { EtlJob } from "./job.ts";
import type { EtlWindow } from "./window.ts";

/**
 * Compiles `job` over `window` into the idempotent rollup statement, as a
 * dialect-agnostic `Sql` fragment (render it with `renderSql`, or execute it
 * via `db.execute`/`db.batch`). The window bounds bind as parameters against
 * the job's window column — `>= from` and `< until`, the half-open contract.
 * Throws `ETL_INVALID_WINDOW` when `from` does not precede `until`.
 */
export function rollup(job: EtlJob, window: EtlWindow): Sql {
  if (
    typeof window?.from !== "string" || typeof window?.until !== "string" ||
    !(window.from < window.until)
  ) {
    throw new OrmError(
      `ETL window must be half-open with from < until, got ` +
        `[${window?.from}, ${window?.until})`,
      { code: "ETL_INVALID_WINDOW", status: 400, details: { ...window } },
    );
  }
  const target = job.target.columns as Record<string, unknown>;
  const bucket = dateTrunc(job.grain, job.window);

  const projection: Record<string, unknown> = { [job.bucket]: bucket };
  const groupKeys: unknown[] = [];
  const conflictTarget: unknown[] = [target[job.bucket]];
  for (const [key, column] of Object.entries(job.groupBy)) {
    projection[key] = column;
    groupKeys.push(column);
    conflictTarget.push(target[key]);
  }
  const set: Record<string, unknown> = {};
  for (const key of Object.keys(job.aggregates)) {
    projection[key] = job.aggregates[key];
    set[key] = excluded(target[key]);
  }

  return assembleInsertFromSelect({
    into: job.target,
    select: {
      select: projection,
      from: job.source,
      where: and(
        gte(job.window, window.from),
        lt(job.window, window.until),
      ),
      groupBy: [bucket, ...groupKeys],
    },
    onConflictDoUpdate: { target: conflictTarget, set },
  });
}

/** Options for {@link explain}. */
export interface EtlExplainOptions {
  /** Dialect to render for (defaults to `"postgres"`, the first-class target). */
  readonly dialect?: SqlDialect;
  /** Engine variant (e.g. `"mariadb"`), forwarded to the renderer. */
  readonly variant?: string;
  /** Server version string, forwarded to the renderer. */
  readonly version?: string;
}

/**
 * Dry-run: renders the **exact** SQL {@link rollup} would send for `job` over
 * `window` — driver text plus bound parameters — without executing anything.
 * This is how "generated, pushed-down SQL" is verified (and golden-pinned per
 * dialect); `run()` additionally batches the checkpoint's watermark upsert
 * after this statement. Dialects with no rollup rendering (`generic`) throw
 * the renderer's typed `ORM_DIALECT_UNSUPPORTED` instead of degrading.
 */
export function explain(
  job: EtlJob,
  window: EtlWindow,
  options: EtlExplainOptions = {},
): SqlQuery {
  return renderSql(rollup(job, window), {
    dialect: options.dialect ?? "postgres",
    ...(options.variant === undefined ? {} : { variant: options.variant }),
    ...(options.version === undefined ? {} : { version: options.version }),
  });
}
