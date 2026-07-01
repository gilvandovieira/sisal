/**
 * Retention / consolidation (step 4 of the chain): keep tables bounded.
 *
 * The model: raw events are short-lived. Once folded into hourly buckets they
 * can be rolled up into daily, then monthly, summaries — and the consolidated
 * raw events can be pruned. Long-term statistics survive in the rollups even
 * after the raw events are gone.
 *
 *   events --fold--> hourly buckets --rollupDaily--> daily --rollupMonthly--> monthly
 *   events --pruneEvents(before)--> (deleted, after consolidation)
 *
 * Each step is one set-based SQL statement (insert-from-select / bulk delete) —
 * batch computation, documented pressure points. Triggered manually here; in
 * production an external cron/scheduler would call them.
 *
 * @module
 */

import { sql } from "@sisal/orm";
import type { NeonDatabase } from "./db.ts";

/** Rolls hourly buckets in `[from, until)` up to daily. Returns rows written. */
export async function rollupDaily(
  db: NeonDatabase,
  from: Date,
  until: Date,
): Promise<number> {
  const result = await db.query<{ n: number }>(
    sql`select app.rollup_daily(${from}::timestamptz, ${until}::timestamptz) as n`,
  );
  return Number(result.rows[0].n);
}

/** Rolls daily rollups in `[from, until)` up to monthly. Returns rows written. */
export async function rollupMonthly(
  db: NeonDatabase,
  from: Date,
  until: Date,
): Promise<number> {
  const result = await db.query<{ n: number }>(
    sql`select app.rollup_monthly(${from}::timestamptz, ${until}::timestamptz) as n`,
  );
  return Number(result.rows[0].n);
}

/** Deletes raw events older than `before` (post-consolidation). Returns count. */
export async function pruneEvents(
  db: NeonDatabase,
  before: Date,
): Promise<number> {
  const result = await db.query<{ n: number }>(
    sql`select app.prune_events(${before}::timestamptz) as n`,
  );
  return Number(result.rows[0].n);
}
