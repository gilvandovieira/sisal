/**
 * The rising-score model: pure TypeScript helpers + the recompute CTEs.
 *
 * This example computes everything with **data-modifying CTEs**, not database
 * functions. The recompute is now authored **builder-native** with
 * `db.with(...).update(...).from(...)` (v0.5.0 roadmap items 9 + 12) — it still
 * renders as one `UPDATE … FROM` over chained CTEs, but the moving-window
 * aggregates are `filter(sum(…))` + `dateSub(now, …)` instead of raw SQL. (The
 * recording mutation in src/activity.ts stays a raw CTE; see the README
 * "Sisal API pressure points".) The pure helpers (`bucket5m`,
 * `bucketActivityScore`, `calculateRisingScoreTs`) exist so the model is
 * unit-testable without a database; they are kept aligned with the SQL (same
 * constants, same window boundaries) and the gated suite asserts the two agree.
 *
 * Everything is deterministic: like the SQL, the helpers and the CTEs take the
 * reference time (`now` / `p_now`) as an argument and never read the wall clock.
 * Times are plain JS `Date` (`mode: "date"` columns; raw rows come back as
 * `Date` from `@neon/serverless`).
 *
 * @module
 */

import { and, dateSub, eq, filter, gte, lt, lte, sql, sum } from "@sisal/orm";
import type { NeonDatabase } from "./db.ts";
import { postActivityBuckets, posts } from "./schema.ts";
import type { Post } from "./schema.ts";

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

/**
 * The updated post row returned by a single recompute, plus the window parts.
 *
 * The stored fields (`id`, `rising_score`, `rising_score_updated_at`) are
 * **derived from the {@link Post} table model** rather than restated, so the
 * shape can't drift from the schema (v0.5.0 roadmap item 13). A recompute always
 * sets `rising_score_updated_at`, so it narrows the model's nullable column.
 */
export interface RecomputedPost extends Pick<Post, "id" | "rising_score"> {
  readonly rising_score_updated_at: NonNullable<
    Post["rising_score_updated_at"]
  >;
  readonly last_15m_score: number;
  readonly last_60m_score: number;
  readonly previous_60m_score: number;
  readonly acceleration_bonus: number;
}

/**
 * Recomputes one post's rising score at `now` and stores it — ONE
 * data-modifying CTE statement, now authored **builder-native** with
 * `db.with(...).update(...).from(...)` instead of a raw SQL string (v0.5.0
 * roadmap items 9 + 12). It still renders as one `UPDATE … FROM` over chained
 * CTEs (the same SQL the raw version sent), so the example keeps teaching the
 * CTE approach — only the authoring moves from a template literal to the
 * builder.
 *
 * Stages: `score_windows` (filtered moving-window aggregates — `filter(sum(…))`
 * over `dateSub(now, …)` bounds, item 9 — `LEFT JOIN`ed from `posts` so a post
 * with no recent buckets still yields a row to update) → `computed_score`
 * (formula) → the `UPDATE posts … FROM computed_score … RETURNING`. The recent
 * windows are bounded `<= now` so a bucket dated after `now` never counts.
 */
export async function recomputePostRisingScore(
  db: NeonDatabase,
  args: { readonly postId: string; readonly now: Date },
): Promise<RecomputedPost> {
  const b = postActivityBuckets.columns;
  // The caller pins `now` (deterministic); type it once for Postgres.
  const at = sql`${args.now}::timestamptz`;
  const minsAgo = (minutes: number) => dateSub(at, { minutes });
  // The post's recent buckets, bounded `<= now`, joined so a post with no
  // activity still produces one (zero) row — matching the raw CTE's behavior.
  const recentBuckets = and(
    eq(b.post_id, posts.columns.id),
    gte(b.bucket_start, minsAgo(120)),
    lte(b.bucket_start, at),
  );

  const scoreWindows = db.$with("score_windows").as(
    db.select({
      post_id: posts.columns.id,
      last_15m_score: sql`coalesce(${
        filter(
          sum(b.activity_score),
          and(gte(b.bucket_start, minsAgo(15)), lte(b.bucket_start, at)),
        )
      }, 0)`,
      last_60m_score: sql`coalesce(${
        filter(
          sum(b.activity_score),
          and(gte(b.bucket_start, minsAgo(60)), lte(b.bucket_start, at)),
        )
      }, 0)`,
      previous_60m_score: sql`coalesce(${
        filter(
          sum(b.activity_score),
          and(
            gte(b.bucket_start, minsAgo(120)),
            lt(b.bucket_start, minsAgo(60)),
          ),
        )
      }, 0)`,
    })
      .from(posts)
      .leftJoin(postActivityBuckets, recentBuckets)
      .where(eq(posts.columns.id, sql`${args.postId}::uuid`))
      .groupBy(posts.columns.id),
  );

  const computedScore = db.$with("computed_score").as(
    db.select({
      post_id: scoreWindows.post_id,
      last_15m_score: scoreWindows.last_15m_score,
      last_60m_score: scoreWindows.last_60m_score,
      previous_60m_score: scoreWindows.previous_60m_score,
      acceleration_bonus:
        sql`greatest(${scoreWindows.last_15m_score} - (${scoreWindows.previous_60m_score} / 4.0), 0)`,
      rising_score:
        sql`(${scoreWindows.last_15m_score} * 3.0 + ${scoreWindows.last_60m_score} + greatest(${scoreWindows.last_15m_score} - (${scoreWindows.previous_60m_score} / 4.0), 0) * 2.0)`,
    }).from(scoreWindows),
  );

  const result = await db.with(scoreWindows, computedScore)
    .update(posts)
    .set({
      rising_score: sql`${computedScore.rising_score}`,
      rising_score_updated_at: at,
      updated_at: at,
    })
    .from(computedScore)
    .where(eq(posts.columns.id, computedScore.post_id))
    .returning({
      id: posts.columns.id,
      rising_score: posts.columns.rising_score,
      rising_score_updated_at: posts.columns.rising_score_updated_at,
      last_15m_score: computedScore.last_15m_score,
      last_60m_score: computedScore.last_60m_score,
      previous_60m_score: computedScore.previous_60m_score,
      acceleration_bonus: computedScore.acceleration_bonus,
    })
    .execute();

  // The builder's UPDATE result type isn't narrowed by `.returning(projection)`,
  // so name the projected row shape explicitly.
  const row = result.rows[0] as unknown as RecomputedPost | undefined;
  if (row === undefined) {
    throw new Error(`recomputePostRisingScore: post ${args.postId} not found`);
  }
  return row;
}

/**
 * Recomputes and stores the rising score for every published post at `now` —
 * ONE `UPDATE … FROM` over chained CTEs, authored builder-native (v0.5.0
 * roadmap items 9 + 12). Returns the number of posts updated.
 *
 * `score_windows` aggregates each published post's recent buckets (`LEFT JOIN`
 * so posts with no recent activity get 0), `computed_score` applies the formula,
 * and the `UPDATE posts … FROM computed_score` writes them all at once.
 */
export async function recomputeAllRisingScores(
  db: NeonDatabase,
  args: { readonly now: Date },
): Promise<number> {
  const b = postActivityBuckets.columns;
  const at = sql`${args.now}::timestamptz`;
  const minsAgo = (minutes: number) => dateSub(at, { minutes });
  const recentBuckets = and(
    eq(b.post_id, posts.columns.id),
    gte(b.bucket_start, minsAgo(120)),
    lte(b.bucket_start, at),
  );

  const scoreWindows = db.$with("score_windows").as(
    db.select({
      post_id: posts.columns.id,
      last_15m_score: sql`coalesce(${
        filter(
          sum(b.activity_score),
          and(gte(b.bucket_start, minsAgo(15)), lte(b.bucket_start, at)),
        )
      }, 0)`,
      last_60m_score: sql`coalesce(${
        filter(
          sum(b.activity_score),
          and(gte(b.bucket_start, minsAgo(60)), lte(b.bucket_start, at)),
        )
      }, 0)`,
      previous_60m_score: sql`coalesce(${
        filter(
          sum(b.activity_score),
          and(
            gte(b.bucket_start, minsAgo(120)),
            lt(b.bucket_start, minsAgo(60)),
          ),
        )
      }, 0)`,
    })
      .from(posts)
      .leftJoin(postActivityBuckets, recentBuckets)
      .where(eq(posts.columns.status, "published"))
      .groupBy(posts.columns.id),
  );

  const computedScore = db.$with("computed_score").as(
    db.select({
      post_id: scoreWindows.post_id,
      rising_score:
        sql`(${scoreWindows.last_15m_score} * 3.0 + ${scoreWindows.last_60m_score} + greatest(${scoreWindows.last_15m_score} - (${scoreWindows.previous_60m_score} / 4.0), 0) * 2.0)`,
    }).from(scoreWindows),
  );

  const result = await db.with(scoreWindows, computedScore)
    .update(posts)
    .set({
      rising_score: sql`${computedScore.rising_score}`,
      rising_score_updated_at: at,
      updated_at: at,
    })
    .from(computedScore)
    .where(eq(posts.columns.id, computedScore.post_id))
    .returning({ id: posts.columns.id })
    .execute();
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
