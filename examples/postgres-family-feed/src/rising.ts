/**
 * The rising-score model, in TypeScript.
 *
 * This mirrors the PostgreSQL functions in migrations/0002…/0004… exactly,
 * against the same constants. The database is the source of truth at runtime
 * (the score is stored and indexed); this copy exists so the model is
 * unit-testable without a database and so application code can preview a score.
 *
 * Everything is deterministic: like the SQL, it takes the reference time (`now`)
 * as an argument and never reads the wall clock. That is what makes a
 * TIME-DEPENDENT score reproducible in tests. Times are plain JS `Date` (this
 * example uses `mode: "date"` columns).
 *
 * @module
 */

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

/** A bucket positioned in time, used by {@link calculateRisingScore}. */
export interface ScoredBucket {
  /** Start of the 5-minute bucket. */
  readonly bucketStart: Date;
  /** Weighted activity score for the bucket. */
  readonly activityScore: number;
}

/**
 * Normalizes a timestamp to the start of its 5-minute bucket.
 *
 * Mirrors `app.bucket_5m`: floor the absolute epoch seconds to a multiple of
 * `BUCKET_SECONDS`. e.g. 12:00:00–12:04:59 → 12:00:00.
 */
export function bucket5m(at: Date): Date {
  const seconds = Math.floor(at.getTime() / 1000);
  const floored = Math.floor(seconds / BUCKET_SECONDS) * BUCKET_SECONDS;
  return new Date(floored * 1000);
}

/**
 * Weighted score for a single bucket from its counters.
 *
 * Mirrors `app.bucket_activity_score`. Note `uniqueActors` is rewarded
 * separately from raw `upvotes`, so breadth of people beats volume from one.
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
 * Mirrors `app.calculate_rising_score`:
 *
 *   last_15m = Σ activity_score over [now-15m, now]
 *   last_60m = Σ activity_score over [now-60m, now]
 *   prev_60m = Σ activity_score over [now-120m, now-60m)
 *   accel    = max(last_15m - prev_60m / 4, 0)
 *   rising   = last_15m*3 + last_60m + accel*2
 *
 * Buckets after `now` and buckets older than 120m are ignored, matching the SQL
 * (whose windows are bounded `<= p_now` and `>= p_now - 120m`). That symmetry is
 * exactly why the score is time-dependent and must be recomputed.
 */
export function calculateRisingScore(
  buckets: readonly ScoredBucket[],
  now: Date,
): number {
  const nowMs = now.getTime();
  const minute = 60_000;
  // `toMs` is exclusive, so use now+1ms to make the recent windows inclusive of
  // a bucket landing exactly at `now` (matching SQL's `<= p_now`).
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
