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
 * Each step is ONE set-based builder statement since v0.6 (previously the raw
 * `app.rollup_daily` / `app.rollup_monthly` / `app.prune_events` SQL
 * functions): the rollups are `insert().select()` with summed groups over a
 * `dateTrunc` bucket, upserted with `onConflictDoUpdate` + `excluded()`; the
 * prune is a bulk `delete()`. Batch computation either way — triggered
 * manually here; in production an external cron/scheduler would call them.
 *
 * @module
 */

import { and, count, dateTrunc, excluded, gte, lt, sum } from "@sisal/orm";
import type { NeonDatabase } from "./db.ts";
import {
  postActivityBuckets,
  postActivityDaily,
  postActivityMonthly,
  postEvents,
} from "./schema.ts";

/** Rolls hourly buckets in `[from, until)` up to daily. Returns rows written. */
export async function rollupDaily(
  db: NeonDatabase,
  from: Date,
  until: Date,
): Promise<number> {
  const b = postActivityBuckets.columns;
  const d = postActivityDaily.columns;
  const day = dateTrunc("day", b.bucket_start);
  const rolled = await db.insert(postActivityDaily).select(
    db.select({
      post_id: b.post_id,
      day_start: day,
      votes: sum(b.votes),
      comments: sum(b.comments),
      reports: sum(b.reports),
      unique_actors: sum(b.unique_actors),
      active_hours: count(),
    }).from(postActivityBuckets)
      .where(and(gte(b.bucket_start, from), lt(b.bucket_start, until)))
      .groupBy(b.post_id, day),
  ).onConflictDoUpdate({
    target: [d.post_id, d.day_start],
    set: {
      votes: excluded(d.votes),
      comments: excluded(d.comments),
      reports: excluded(d.reports),
      unique_actors: excluded(d.unique_actors),
      active_hours: excluded(d.active_hours),
    },
  }).returning({ post_id: d.post_id }).execute();
  return rolled.rows.length;
}

/** Rolls daily rollups in `[from, until)` up to monthly. Returns rows written. */
export async function rollupMonthly(
  db: NeonDatabase,
  from: Date,
  until: Date,
): Promise<number> {
  const d = postActivityDaily.columns;
  const m = postActivityMonthly.columns;
  const month = dateTrunc("month", d.day_start);
  const rolled = await db.insert(postActivityMonthly).select(
    db.select({
      post_id: d.post_id,
      month_start: month,
      votes: sum(d.votes),
      comments: sum(d.comments),
      reports: sum(d.reports),
      unique_actors: sum(d.unique_actors),
      active_days: count(),
    }).from(postActivityDaily)
      .where(and(gte(d.day_start, from), lt(d.day_start, until)))
      .groupBy(d.post_id, month),
  ).onConflictDoUpdate({
    target: [m.post_id, m.month_start],
    set: {
      votes: excluded(m.votes),
      comments: excluded(m.comments),
      reports: excluded(m.reports),
      unique_actors: excluded(m.unique_actors),
      active_days: excluded(m.active_days),
    },
  }).returning({ post_id: m.post_id }).execute();
  return rolled.rows.length;
}

/** Deletes raw events older than `before` (post-consolidation). Returns count. */
export async function pruneEvents(
  db: NeonDatabase,
  before: Date,
): Promise<number> {
  const pruned = await db.delete(postEvents)
    .where(lt(postEvents.columns.created_at, before))
    .returning({ id: postEvents.columns.id }).execute();
  return pruned.rows.length;
}
