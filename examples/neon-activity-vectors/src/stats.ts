/**
 * Consolidated stats and the vector projection (steps 2–3 of the chain).
 *
 * `computeStats` calls `app.compute_post_activity_stats` — ONE statement that
 * computes every published post's stats at p_now, including the
 * window-function moving averages, and upserts them. That is the centerpiece:
 * SQL as a batch computation engine over the whole set, not a row-by-row loop.
 * Sisal has no builder for window functions or this insert-from-select, so it is
 * a SQL function (a documented pressure point).
 *
 * The "vector" is an ordered projection of the named stats columns —
 * `statsToVector` in TypeScript, or `app.post_activity_vector` in SQL. Both are
 * `double precision[]`, NOT pgvector.
 *
 * @module
 */

import { eq, sql } from "@sisal/orm";
import type { NeonDatabase } from "./db.ts";
import { type PostActivityStats, postActivityStats } from "./schema.ts";
import { buildActivityVector, VECTOR_VERSION } from "./vector.ts";

/** Computes + upserts stats for every published post at `now`. Returns count. */
export async function computeStats(
  db: NeonDatabase,
  now: Date,
): Promise<number> {
  const result = await db.query<{ n: number }>(
    sql`select app.compute_post_activity_stats(${now}::timestamptz) as n`,
  );
  return Number(result.rows[0].n);
}

/** Reads one post's consolidated stats row (builder), or undefined. */
export async function getStats(
  db: NeonDatabase,
  postId: string,
): Promise<PostActivityStats | undefined> {
  const rows = await db.select().from(postActivityStats)
    .where(eq(postActivityStats.columns.post_id, postId))
    .execute();
  return rows[0];
}

/** Projects a stats row into the `activity-v1` vector (mirrors the SQL fn). */
export function statsToVector(s: PostActivityStats): number[] {
  return buildActivityVector({
    votes_1h: Number(s.votes_1h),
    comments_1h: Number(s.comments_1h),
    reports_1h: Number(s.reports_1h),
    unique_actors_1h: Number(s.unique_actors_1h),
    vote_ma_6h: Number(s.vote_ma_6h),
    comment_ma_6h: Number(s.comment_ma_6h),
    hot_score: Number(s.hot_score),
    rising_score: Number(s.rising_score),
    age_minutes: Number(s.age_minutes),
  });
}

/** The vector via the SQL projection `app.post_activity_vector` (raw SQL). */
export async function getActivityVectorSql(
  db: NeonDatabase,
  postId: string,
): Promise<number[]> {
  const result = await db.query<{ v: number[] | null }>(
    sql`select app.post_activity_vector(${postId}::bigint) as v`,
  );
  return (result.rows[0]?.v ?? []).map(Number);
}

export { VECTOR_VERSION };
