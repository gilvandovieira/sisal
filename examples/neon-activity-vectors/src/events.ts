/**
 * Raw events and the events → hourly-buckets fold (step 1 of the chain).
 *
 * `recordEvents` is builder-native (batch insert). `foldEventsToBuckets` calls
 * the `app.fold_events_to_buckets` SQL function — one set-based
 * `INSERT … SELECT … GROUP BY … ON CONFLICT` with `FILTER` aggregates that Sisal
 * has no builder for (a documented pressure point). It folds many events into
 * hourly counters in one statement, not a row-by-row loop.
 *
 * @module
 */

import { sql } from "@sisal/orm";
import type { NeonDatabase } from "./db.ts";
import { postEvents } from "./schema.ts";

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

/**
 * Folds raw events in the half-open window `[from, until)` into hourly buckets
 * (idempotent upsert). Returns the number of (post, hour) buckets written.
 */
export async function foldEventsToBuckets(
  db: NeonDatabase,
  from: Date,
  until: Date,
): Promise<number> {
  const result = await db.query<{ n: number }>(
    sql`select app.fold_events_to_buckets(
      ${from}::timestamptz, ${until}::timestamptz
    ) as n`,
  );
  return Number(result.rows[0].n);
}
