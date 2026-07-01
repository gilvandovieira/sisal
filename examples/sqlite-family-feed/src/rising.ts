/**
 * The rising-score model, in TypeScript — and on libSQL this IS the
 * implementation, not a mirror.
 *
 * The Neon sibling computes these values in PostgreSQL functions
 * (`app.bucket_5m`, `app.bucket_activity_score`, `app.calculate_rising_score`).
 * SQLite has no SQL-language stored procedures, so the same math runs here and
 * is orchestrated through the query builder in src/activity.ts and
 * src/recompute.ts. Everything is deterministic: like the SQL version, it takes
 * the reference time (`now`) as an argument and never reads the wall clock.
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
  /** Start of the 5-minute bucket, as an ISO-8601 UTC string. */
  readonly bucketStart: string;
  /** Weighted activity score for the bucket. */
  readonly activityScore: number;
}

/**
 * Normalizes a timestamp to the start of its 5-minute bucket, returned as an
 * ISO-8601 UTC string (so it sorts and compares lexicographically).
 *
 * Floors the absolute epoch seconds to a multiple of `BUCKET_SECONDS`, e.g.
 * 12:00:00–12:04:59 → "…T12:00:00.000Z".
 */
export function bucket5mIso(at: Date): string {
  const seconds = Math.floor(at.getTime() / 1000);
  const floored = Math.floor(seconds / BUCKET_SECONDS) * BUCKET_SECONDS;
  return new Date(floored * 1000).toISOString();
}

/**
 * Weighted score for a single bucket from its counters.
 *
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
  fromIso: string,
  toIso: string,
): number {
  let total = 0;
  for (const bucket of buckets) {
    // ISO-8601 UTC strings compare chronologically as plain strings.
    if (bucket.bucketStart >= fromIso && bucket.bucketStart < toIso) {
      total += bucket.activityScore;
    }
  }
  return total;
}

/**
 * Computes the moving-window rising score for a post at reference time `now`.
 *
 *   last_15m = Σ activity_score over [now-15m, now]
 *   last_60m = Σ activity_score over [now-60m, now]
 *   prev_60m = Σ activity_score over [now-120m, now-60m)
 *   accel    = max(last_15m - prev_60m / 4, 0)
 *   rising   = last_15m*3 + last_60m + accel*2
 *
 * Old buckets fall out of every window as `now` advances, which is exactly why
 * the score is time-dependent and must be recomputed.
 */
export function calculateRisingScore(
  buckets: readonly ScoredBucket[],
  now: Date,
): number {
  const minute = 60_000;
  const iso = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
  // Inclusive of a bucket landing exactly at `now`.
  const inclusiveNow = new Date(now.getTime() + 1).toISOString();

  const last15m = sumWindow(
    buckets,
    iso(RISING.last15mMinutes * minute),
    inclusiveNow,
  );
  const last60m = sumWindow(
    buckets,
    iso(RISING.last60mMinutes * minute),
    inclusiveNow,
  );
  const prev60m = sumWindow(
    buckets,
    iso(RISING.prev60mMinutes * minute),
    iso(RISING.last60mMinutes * minute),
  );
  const accel = Math.max(last15m - prev60m / 4, 0);
  return last15m * RISING.last15mWeight +
    last60m * RISING.last60mWeight +
    accel * RISING.accelWeight;
}

/** The earliest bucket_start (ISO) that can affect any window at `now`. */
export function windowFloorIso(now: Date): string {
  return new Date(now.getTime() - RISING.prev60mMinutes * 60_000).toISOString();
}
