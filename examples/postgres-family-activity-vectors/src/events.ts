/**
 * Raw events and the events → hourly-buckets fold (step 1 of the chain).
 *
 * `recordEvents` is builder-native (batch insert). `foldEventsToBuckets` is
 * builder-native too since v0.6: ONE `insert().select()` statement — grouped
 * `FILTER` aggregates over `dateTrunc` hour buckets, upserted with
 * `onConflictDoUpdate` + `excluded()` — folds many events into hourly counters
 * set-based, not in a row-by-row loop. (Until v0.6 this was the raw
 * `app.fold_events_to_buckets` SQL function; converting it verified the v0.5
 * pieces compose — the A1 rollup verification in `docs/v0.6.0-roadmap.md`.)
 * The only remaining raw seam is `coalesce(...)`, via the `sql` tag.
 *
 * @module
 */

import {
  and,
  countDistinct,
  dateTrunc,
  eq,
  excluded,
  filter,
  gte,
  lt,
  sql,
  sum,
} from "@sisal/orm";
import type { NeonDatabase } from "./db.ts";
import { postActivityBuckets, postEvents } from "./schema.ts";

/** The event kinds folded into bucket counters. */
export type EventType = "vote" | "comment" | "report";

/** A raw event to record. */
export interface RawEvent {
  readonly post_id: string;
  readonly actor_id: string | null;
  readonly event_type: EventType;
  readonly value?: number;
  readonly created_at: Date;
}

/** Inserts raw events (one builder statement). Returns the count inserted. */
export async function recordEvents(
  db: NeonDatabase,
  events: readonly RawEvent[],
): Promise<number> {
  if (events.length === 0) return 0;
  await db.insert(postEvents).values(
    events.map((e) => ({
      post_id: e.post_id,
      actor_id: e.actor_id,
      event_type: e.event_type,
      value: e.value ?? 1,
      created_at: e.created_at,
    })),
  ).execute();
  return events.length;
}

// A NOT NULL counter needs coalesce: a bucket with no rows of one kind makes
// the FILTERed sum NULL, not 0.
function counter(kind: EventType) {
  const e = postEvents.columns;
  return sql`coalesce(${filter(sum(e.value), eq(e.event_type, kind))}, 0)`;
}

/**
 * Folds raw events in the half-open window `[from, until)` into hourly buckets
 * (idempotent upsert). Returns the number of (post, hour) buckets written.
 */
export async function foldEventsToBuckets(
  db: NeonDatabase,
  from: Date,
  until: Date,
): Promise<number> {
  const e = postEvents.columns;
  const b = postActivityBuckets.columns;
  const bucket = dateTrunc("hour", e.created_at);
  const folded = await db.insert(postActivityBuckets).select(
    db.select({
      post_id: e.post_id,
      bucket_start: bucket,
      votes: counter("vote"),
      comments: counter("comment"),
      reports: counter("report"),
      unique_actors: countDistinct(e.actor_id),
    }).from(postEvents)
      .where(and(gte(e.created_at, from), lt(e.created_at, until)))
      .groupBy(e.post_id, bucket),
  ).onConflictDoUpdate({
    target: [b.post_id, b.bucket_start],
    set: {
      votes: excluded(b.votes),
      comments: excluded(b.comments),
      reports: excluded(b.reports),
      unique_actors: excluded(b.unique_actors),
    },
  }).returning({ post_id: b.post_id }).execute();
  return folded.rows.length;
}
