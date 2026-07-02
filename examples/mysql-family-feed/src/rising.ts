/**
 * The rising-score model, in TypeScript — the portable baseline for the
 * MySQL-family example.
 *
 * MySQL DATETIME literals are intentionally not ISO strings: the adapter writes
 * instants as naive UTC and MySQL rejects trailing `Z`/offset designators in
 * DATETIME literals. The helpers here format fixed-width UTC strings that sort
 * chronologically and match `DATETIME(6)`.
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
  /** Start of the 5-minute bucket, as a MySQL-safe UTC DATETIME string. */
  readonly bucketStart: string;
  /** Weighted activity score for the bucket. */
  readonly activityScore: number;
}

/**
 * Formats a date as a MySQL-safe UTC DATETIME(6) literal:
 * `YYYY-MM-DD HH:mm:ss.SSS000`.
 */
export function mysqlTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "000");
}

/** Parses a MySQL UTC DATETIME string produced by {@link mysqlTimestamp}. */
export function parseMysqlTimestamp(value: string): Date {
  return new Date(value.replace(" ", "T").replace(/(\.\d{3})\d{3}$/, "$1Z"));
}

/**
 * Normalizes a timestamp to the start of its 5-minute bucket, returned as a
 * MySQL-safe UTC DATETIME string.
 */
export function bucket5mMysql(at: Date): string {
  const seconds = Math.floor(at.getTime() / 1000);
  const floored = Math.floor(seconds / BUCKET_SECONDS) * BUCKET_SECONDS;
  return mysqlTimestamp(new Date(floored * 1000));
}

/** Back-compat alias for the sibling examples' helper name. */
export const bucket5mIso = bucket5mMysql;

/** Weighted score for a single bucket from its counters. */
export function bucketActivityScore(counts: BucketCounts): number {
  return counts.upvotes * ACTIVITY_WEIGHTS.upvote +
    counts.downvotes * ACTIVITY_WEIGHTS.downvote +
    counts.comments * ACTIVITY_WEIGHTS.comment +
    counts.uniqueActors * ACTIVITY_WEIGHTS.uniqueActor +
    counts.reports * ACTIVITY_WEIGHTS.report;
}

function sumWindow(
  buckets: readonly ScoredBucket[],
  from: string,
  to: string,
): number {
  let total = 0;
  for (const bucket of buckets) {
    if (bucket.bucketStart >= from && bucket.bucketStart < to) {
      total += bucket.activityScore;
    }
  }
  return total;
}

/**
 * Computes the moving-window rising score for a post at reference time `now`.
 */
export function calculateRisingScore(
  buckets: readonly ScoredBucket[],
  now: Date,
): number {
  const minute = 60_000;
  const at = (msAgo: number) =>
    mysqlTimestamp(
      new Date(now.getTime() - msAgo),
    );
  const inclusiveNow = mysqlTimestamp(new Date(now.getTime() + 1));

  const last15m = sumWindow(
    buckets,
    at(RISING.last15mMinutes * minute),
    inclusiveNow,
  );
  const last60m = sumWindow(
    buckets,
    at(RISING.last60mMinutes * minute),
    inclusiveNow,
  );
  const prev60m = sumWindow(
    buckets,
    at(RISING.prev60mMinutes * minute),
    at(RISING.last60mMinutes * minute),
  );
  const accel = Math.max(last15m - prev60m / 4, 0);
  return last15m * RISING.last15mWeight +
    last60m * RISING.last60mWeight +
    accel * RISING.accelWeight;
}

/** The earliest bucket_start that can affect any window at `now`. */
export function windowFloorMysql(now: Date): string {
  return mysqlTimestamp(
    new Date(now.getTime() - RISING.prev60mMinutes * 60_000),
  );
}

/** Back-compat alias for the sibling examples' helper name. */
export const windowFloorIso = windowFloorMysql;
