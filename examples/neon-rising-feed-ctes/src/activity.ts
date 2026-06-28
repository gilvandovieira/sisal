/**
 * Recording activity as ONE data-modifying CTE statement (no database
 * function).
 *
 * `recordPostActivity` sends a single parameterized statement that:
 *
 *   1. binds (post_id, actor_id, kind, at),
 *   2. validates `kind` in SQL (`validated_input`),
 *   3. computes the 5-minute `bucket_start` inline (`bucket_data`),
 *   4. inserts the actor `ON CONFLICT DO NOTHING` (`actor_insert`),
 *   5. flags whether the actor was newly inserted (`actor_flag`),
 *   6. upserts the bucket, incrementing the right counter and `unique_actors`
 *      only on a first touch, and recomputing `activity_score` inline
 *      (`bucket_upsert`),
 *   7. returns the updated bucket.
 *
 * It is atomic inside the server's implicit transaction — one round trip, no
 * interactive `db.transaction(tx => { ... })` callback. That is the whole point
 * of the CTE approach: Neon HTTP-friendly multi-step mutation without a stored
 * function. The cost is a large, raw, less-reusable SQL string (see the README
 * "CTEs vs database functions" and "Sisal API pressure points").
 *
 * Invalid `kind`: `validated_input` filters it out, so the statement returns no
 * rows and this wrapper throws a clear error.
 *
 * @module
 */

import { sql } from "@sisal/orm";
import type { NeonDatabase } from "./db.ts";
import type { ActivityKind } from "./rising.ts";

export type { ActivityKind };

/** The bucket row returned by the recording CTE (mirror of the table row). */
export interface RecordedBucket {
  readonly post_id: string;
  readonly bucket_start: Date;
  readonly upvotes: number;
  readonly downvotes: number;
  readonly comments: number;
  readonly reports: number;
  readonly unique_actors: number;
  readonly activity_score: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/**
 * Records one activity event and returns the updated bucket.
 *
 * `at` is the event time; pass it explicitly (it drives the inline bucket
 * expression) so seeding and tests are deterministic instead of depending on
 * `now()`. All values are bound parameters — never string-concatenated.
 */
export async function recordPostActivity(
  db: NeonDatabase,
  input: {
    readonly postId: string;
    readonly actorId: string;
    readonly kind: ActivityKind;
    readonly at: Date;
  },
): Promise<RecordedBucket> {
  const result = await db.query<RecordedBucket>(sql`
    with input_data as (
      select
        ${input.postId}::uuid as post_id,
        ${input.actorId}::uuid as actor_id,
        ${input.kind}::text as kind,
        ${input.at}::timestamptz as activity_at
    ),
    validated_input as (
      -- Invalid kinds drop out here; the whole statement then returns no rows.
      select * from input_data
      where kind in ('upvote', 'downvote', 'comment', 'report')
    ),
    bucket_data as (
      select
        post_id,
        actor_id,
        kind,
        activity_at,
        date_trunc('hour', activity_at)
          + floor(extract(minute from activity_at) / 5) * interval '5 minutes'
          as bucket_start
      from validated_input
    ),
    actor_insert as (
      -- First touch inserts; a repeat touch is a no-op (so unique_actors is not
      -- inflated). The RETURNING rows tell us whether it was a first touch.
      insert into post_activity_actors (post_id, bucket_start, actor_id, created_at)
      select post_id, bucket_start, actor_id, activity_at from bucket_data
      on conflict do nothing
      returning post_id, bucket_start, actor_id
    ),
    actor_flag as (
      select
        bucket_data.*,
        exists (select 1 from actor_insert) as is_new_actor
      from bucket_data
    ),
    bucket_upsert as (
      insert into post_activity_buckets (
        post_id, bucket_start, upvotes, downvotes, comments, reports,
        unique_actors, activity_score, created_at, updated_at
      )
      select
        post_id,
        bucket_start,
        case when kind = 'upvote' then 1 else 0 end,
        case when kind = 'downvote' then 1 else 0 end,
        case when kind = 'comment' then 1 else 0 end,
        case when kind = 'report' then 1 else 0 end,
        case when is_new_actor then 1 else 0 end,
        -- activity_score for the brand-new bucket, from this single event.
        (case when kind = 'upvote' then 1 else 0 end) * 1.0
          + (case when kind = 'downvote' then 1 else 0 end) * -0.5
          + (case when kind = 'comment' then 1 else 0 end) * 3.0
          + (case when is_new_actor then 1 else 0 end) * 2.0
          + (case when kind = 'report' then 1 else 0 end) * -8.0,
        activity_at,
        activity_at
      from actor_flag
      on conflict (post_id, bucket_start) do update set
        upvotes = post_activity_buckets.upvotes + excluded.upvotes,
        downvotes = post_activity_buckets.downvotes + excluded.downvotes,
        comments = post_activity_buckets.comments + excluded.comments,
        reports = post_activity_buckets.reports + excluded.reports,
        unique_actors = post_activity_buckets.unique_actors
          + excluded.unique_actors,
        -- Recompute the score from the post-update counters so the stored score
        -- and the counters never disagree.
        activity_score =
          (post_activity_buckets.upvotes + excluded.upvotes) * 1.0
          + (post_activity_buckets.downvotes + excluded.downvotes) * -0.5
          + (post_activity_buckets.comments + excluded.comments) * 3.0
          + (post_activity_buckets.unique_actors + excluded.unique_actors) * 2.0
          + (post_activity_buckets.reports + excluded.reports) * -8.0,
        updated_at = excluded.updated_at
      returning
        post_id, bucket_start, upvotes, downvotes, comments, reports,
        unique_actors, activity_score, created_at, updated_at
    )
    select * from bucket_upsert;
  `);

  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(
      `recordPostActivity: no bucket returned (invalid kind "${input.kind}"?)`,
    );
  }
  return row;
}
