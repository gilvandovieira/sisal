/**
 * Recording activity: one statement, atomically.
 *
 * The read-modify-write (dedupe the actor, bump the right counter, bump
 * unique_actors only on the actor's first touch in the bucket, recompute the
 * bucket score) lives in the PostgreSQL function `app.record_post_activity`. We
 * declare it once as a typed `defineFunction` descriptor and call it with
 * `db.call(...).one()` — a single parameterized statement with the
 * `::uuid` / `::text` / `::timestamptz` casts taken from the argument column
 * types, so there is no raw `sql` string, no interactive transaction callback,
 * and no connection held open across round trips (the Deno Deploy + Neon HTTP
 * friendly shape).
 *
 * Contrast the libSQL sibling example: SQLite has no stored procedures, so the
 * same logic there is orchestrated in TypeScript inside `db.transaction(...)`.
 * That divergence is the headline finding of this pair (see the README).
 *
 * @module
 */

import { columns, defineFunction } from "@sisal/orm";
import type { NeonDatabase } from "@sisal/neon";
import type { ActivityKind } from "./rising.ts";

export type { ActivityKind };

/** The bucket row returned by `app.record_post_activity` after recording. */
export interface RecordedBucket {
  readonly post_id: string;
  readonly bucket_start: Date;
  readonly upvotes: number;
  readonly downvotes: number;
  readonly comments: number;
  readonly reports: number;
  readonly unique_actors: number;
  readonly activity_score: number;
}

/**
 * Typed descriptor for
 * `app.record_post_activity(post_id uuid, actor_id uuid, kind text, at
 * timestamptz) RETURNS TABLE (...)`. Arguments are positional and cast from
 * these column types; the result row is typed from `returns`.
 */
const recordActivityFn = defineFunction("app.record_post_activity", {
  args: {
    postId: columns.uuid(),
    actorId: columns.uuid(),
    kind: columns.text(),
    at: columns.timestamp({ withTimezone: true, mode: "date" }),
  },
  returns: {
    post_id: columns.uuid().notNull(),
    bucket_start: columns.timestamp({ withTimezone: true, mode: "date" })
      .notNull(),
    upvotes: columns.integer().notNull(),
    downvotes: columns.integer().notNull(),
    comments: columns.integer().notNull(),
    reports: columns.integer().notNull(),
    unique_actors: columns.integer().notNull(),
    activity_score: columns.doublePrecision().notNull(),
  },
});

/**
 * Records one activity event and returns the updated bucket.
 *
 * `at` is the event time; pass it explicitly (it flows into `app.bucket_5m`)
 * so seeding and tests stay deterministic instead of depending on `now()`.
 * Values are bound parameters and cast in SQL — never string-concatenated.
 */
export function recordPostActivity(
  db: NeonDatabase,
  args: {
    readonly postId: string;
    readonly actorId: string;
    readonly kind: ActivityKind;
    readonly at: Date;
  },
): Promise<RecordedBucket> {
  return db.call(recordActivityFn, args).one();
}
