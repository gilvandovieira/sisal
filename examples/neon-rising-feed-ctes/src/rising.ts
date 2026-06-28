/**
 * The rising-score model: pure TypeScript helpers + the recompute CTEs.
 *
 * This example computes everything with **data-modifying CTEs**, not database
 * functions. The pure helpers (`bucket5m`, `bucketActivityScore`,
 * `calculateRisingScoreTs`) exist so the model is unit-testable without a
 * database; the SQL is the source of truth at runtime and is kept byte-for-byte
 * aligned with these helpers (same constants, same window boundaries).
 *
 * Everything is deterministic: like the SQL, the helpers and the CTEs take the
 * reference time (`now` / `p_now`) as an argument and never read the wall clock.
 * Times are plain JS `Date` (`mode: "date"` columns; raw rows come back as
 * `Date` from `@neon/serverless`).
 *
 * @module
 */

import { sql } from "@sisal/orm";
import type { NeonDatabase } from "./db.ts";

/** Width of one activity bucket, in seconds (5 minutes). */
export const BUCKET_SECONDS = 300;

/** Per-event weights that build a bucket's `activity_score`. */
export const ACTIVITY_WEIGHTS = {
  upvote: 1,
  downvote: -0.5,
  comment: 3,
  uniqueActor: 2,
  report: -8,
} as const;

/** Moving-window widths (minutes) and term multipliers for the rising score. */
export const RISING = {
  last15mMinutes: 15,
  last60mMinutes: 60,
  prev60mMinutes: 120,
  last15mWeight: 3,
  last60mWeight: 1,
  accelWeight: 2,
} as const;

/** The four activity event kinds a bucket counts. */
export type ActivityKind = "upvote" | "downvote" | "comment" | "report";

/** Counters that make up one bucket (mirror of `post_activity_buckets`). */
export interface BucketCounts {
  readonly upvotes: number;
  readonly downvotes: number;
  readonly comments: number;
  readonly uniqueActors: number;
  readonly reports: number;
}

/** A bucket positioned in time, used by {@link calculateRisingScoreTs}. */
export interface ScoredBucket {
  /** Start of the 5-minute bucket. */
  readonly bucketStart: Date;
  /** Weighted activity score for the bucket. */
  readonly activityScore: number;
}

/**
 * Normalizes a timestamp to the start of its 5-minute bucket.
 *
 * Mirrors the SQL bucket expression
 * `date_trunc('hour', at) + floor(extract(minute from at) / 5) * interval '5
 * minutes'`: both floor to the same 5-minute boundary (seconds/subseconds
 * dropped). e.g. 12:37:59 → 12:35:00.
 */
export function bucket5m(at: Date): Date {
  const seconds = Math.floor(at.getTime() / 1000);
  const floored = Math.floor(seconds / BUCKET_SECONDS) * BUCKET_SECONDS;
  return new Date(floored * 1000);
}

/**
 * Weighted score for a single bucket from its counters.
 *
 * Mirrors the inline `activity_score` expression in the recording CTE. Note
 * `uniqueActors` is rewarded separately from raw `upvotes`, so breadth of
 * people beats volume from one.
 */
export function bucketActivityScore(counts: BucketCounts): number {
  return counts.upvotes * ACTIVITY_WEIGHTS.upvote +
    counts.downvotes * ACTIVITY_WEIGHTS.downvote +
    counts.comments * ACTIVITY_WEIGHTS.comment +
    counts.uniqueActors * ACTIVITY_WEIGHTS.uniqueActor +
    counts.reports * ACTIVITY_WEIGHTS.report;
}

function sumWindow(
  buckets: readonly ScoredBucket[],
  fromMs: number,
  toMs: number,
): number {
  let total = 0;
  for (const bucket of buckets) {
    const t = bucket.bucketStart.getTime();
    if (t >= fromMs && t < toMs) total += bucket.activityScore;
  }
  return total;
}

/**
 * Computes the moving-window rising score for a post at reference time `now`.
 *
 * Mirrors the `score_windows` + `computed_score` CTEs:
 *
 *   last_15m = Σ activity_score over [now-15m, now]
 *   last_60m = Σ activity_score over [now-60m, now]
 *   prev_60m = Σ activity_score over [now-120m, now-60m)
 *   accel    = max(last_15m - prev_60m / 4, 0)
 *   rising   = last_15m*3 + last_60m + accel*2
 *
 * Buckets after `now` and buckets older than 120m are ignored, matching the SQL
 * (windows bounded `<= now` and `>= now - 120m`).
 */
export function calculateRisingScoreTs(
  buckets: readonly ScoredBucket[],
  now: Date,
): number {
  const nowMs = now.getTime();
  const minute = 60_000;
  // Inclusive of a bucket landing exactly at `now` (matches SQL `<= now`).
  const inclusiveNow = nowMs + 1;
  const last15m = sumWindow(
    buckets,
    nowMs - RISING.last15mMinutes * minute,
    inclusiveNow,
  );
  const last60m = sumWindow(
    buckets,
    nowMs - RISING.last60mMinutes * minute,
    inclusiveNow,
  );
  const prev60m = sumWindow(
    buckets,
    nowMs - RISING.prev60mMinutes * minute,
    nowMs - RISING.last60mMinutes * minute,
  );
  const accel = Math.max(last15m - prev60m / 4, 0);
  return last15m * RISING.last15mWeight +
    last60m * RISING.last60mWeight +
    accel * RISING.accelWeight;
}

/** The updated post row returned by a single recompute, plus the window parts. */
export interface RecomputedPost {
  readonly id: string;
  readonly rising_score: number;
  readonly rising_score_updated_at: Date;
  readonly last_15m_score: number;
  readonly last_60m_score: number;
  readonly previous_60m_score: number;
  readonly acceleration_bonus: number;
}

/**
 * Recomputes one post's rising score at `now` and stores it — ONE
 * data-modifying CTE statement (no `app.calculate_rising_score` function).
 *
 * Stages: `input_data` (bound params) → `score_windows` (filtered moving-window
 * aggregates over the post's recent buckets) → `computed_score` (formula) →
 * `updated_post` (`UPDATE … FROM computed_score … RETURNING`). The recent
 * windows are bounded `<= now` so a bucket dated after `now` never counts.
 */
export async function recomputePostRisingScore(
  db: NeonDatabase,
  args: { readonly postId: string; readonly now: Date },
): Promise<RecomputedPost> {
  const result = await db.query<RecomputedPost>(sql`
    with input_data as (
      select ${args.postId}::uuid as post_id, ${args.now}::timestamptz as now_at
    ),
    score_windows as (
      select
        input_data.post_id,
        input_data.now_at,
        coalesce(sum(b.activity_score) filter (
          where b.bucket_start >= input_data.now_at - interval '15 minutes'
            and b.bucket_start <= input_data.now_at
        ), 0) as last_15m_score,
        coalesce(sum(b.activity_score) filter (
          where b.bucket_start >= input_data.now_at - interval '60 minutes'
            and b.bucket_start <= input_data.now_at
        ), 0) as last_60m_score,
        coalesce(sum(b.activity_score) filter (
          where b.bucket_start >= input_data.now_at - interval '120 minutes'
            and b.bucket_start < input_data.now_at - interval '60 minutes'
        ), 0) as previous_60m_score
      from input_data
      left join post_activity_buckets b
        on b.post_id = input_data.post_id
        and b.bucket_start >= input_data.now_at - interval '120 minutes'
        and b.bucket_start <= input_data.now_at
      group by input_data.post_id, input_data.now_at
    ),
    computed_score as (
      select
        post_id,
        now_at,
        last_15m_score,
        last_60m_score,
        previous_60m_score,
        greatest(last_15m_score - (previous_60m_score / 4.0), 0)
          as acceleration_bonus,
        (
          last_15m_score * 3.0
          + last_60m_score
          + greatest(last_15m_score - (previous_60m_score / 4.0), 0) * 2.0
        ) as rising_score
      from score_windows
    ),
    updated_post as (
      update posts
      set
        rising_score = computed_score.rising_score,
        rising_score_updated_at = computed_score.now_at,
        updated_at = computed_score.now_at
      from computed_score
      where posts.id = computed_score.post_id
      returning
        posts.id,
        posts.rising_score,
        posts.rising_score_updated_at,
        computed_score.last_15m_score,
        computed_score.last_60m_score,
        computed_score.previous_60m_score,
        computed_score.acceleration_bonus
    )
    select * from updated_post;
  `);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`recomputePostRisingScore: post ${args.postId} not found`);
  }
  return row;
}

/**
 * Recomputes and stores the rising score for every published post at `now` —
 * ONE data-modifying CTE statement. Returns the number of posts updated.
 *
 * `post_scope` selects all published posts, `score_windows` aggregates each
 * post's recent buckets (LEFT JOIN so posts with no recent activity get 0), and
 * `updated_posts` writes them all in one `UPDATE … FROM`.
 */
export async function recomputeAllRisingScores(
  db: NeonDatabase,
  args: { readonly now: Date },
): Promise<number> {
  const result = await db.query<{ id: string }>(sql`
    with input_data as (
      select ${args.now}::timestamptz as now_at
    ),
    post_scope as (
      select id as post_id from posts where status = 'published'
    ),
    score_windows as (
      select
        post_scope.post_id,
        input_data.now_at,
        coalesce(sum(b.activity_score) filter (
          where b.bucket_start >= input_data.now_at - interval '15 minutes'
            and b.bucket_start <= input_data.now_at
        ), 0) as last_15m_score,
        coalesce(sum(b.activity_score) filter (
          where b.bucket_start >= input_data.now_at - interval '60 minutes'
            and b.bucket_start <= input_data.now_at
        ), 0) as last_60m_score,
        coalesce(sum(b.activity_score) filter (
          where b.bucket_start >= input_data.now_at - interval '120 minutes'
            and b.bucket_start < input_data.now_at - interval '60 minutes'
        ), 0) as previous_60m_score
      from post_scope
      cross join input_data
      left join post_activity_buckets b
        on b.post_id = post_scope.post_id
        and b.bucket_start >= input_data.now_at - interval '120 minutes'
        and b.bucket_start <= input_data.now_at
      group by post_scope.post_id, input_data.now_at
    ),
    computed_score as (
      select
        post_id,
        now_at,
        (
          last_15m_score * 3.0
          + last_60m_score
          + greatest(last_15m_score - (previous_60m_score / 4.0), 0) * 2.0
        ) as rising_score
      from score_windows
    ),
    updated_posts as (
      update posts
      set
        rising_score = computed_score.rising_score,
        rising_score_updated_at = computed_score.now_at,
        updated_at = computed_score.now_at
      from computed_score
      where posts.id = computed_score.post_id
      returning posts.id
    )
    select id from updated_posts;
  `);
  return result.rows.length;
}

async function main(): Promise<void> {
  const { openDb } = await import("./db.ts");
  const db = await openDb();
  try {
    const now = new Date();
    const updated = await recomputeAllRisingScores(db, { now });
    console.log(
      `recomputed rising_score for ${updated} post(s) at ${now.toISOString()}.`,
    );
  } finally {
    await db.close();
  }
}

if (import.meta.main) {
  await main();
}
