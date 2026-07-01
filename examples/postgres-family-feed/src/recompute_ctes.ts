/**
 * Alternate recompute strategy: **builder-native chained CTEs** (no database
 * function).
 *
 * `src/recompute.ts` recomputes the stored `rising_score` by calling PostgreSQL
 * functions through `db.call(...)`. This module does the *same* recompute
 * entirely in the query builder — `db.with(scoreWindows, computedScore)
 * .update(posts).from(computedScore).returning(...)` — rendering one
 * `UPDATE … FROM` over chained CTEs, with the moving-window aggregates as
 * `filter(sum(...))` over `dateSub(now, …)` bounds (v0.5.0 roadmap items 9 + 12).
 * It is the technique the former `neon-rising-feed-ctes` example demonstrated,
 * folded into the family example (it works over any PostgreSQL-family driver).
 *
 * Run it with `deno task recompute:ctes`. Everything is deterministic: `now` is
 * an explicit argument, never the wall clock.
 *
 * @module
 */

import { and, dateSub, eq, filter, gte, lt, lte, sql, sum } from "@sisal/orm";
import type { PgDatabase } from "./db.ts";
import { postActivityBuckets, posts } from "./schema.ts";

/** The updated post row returned by a single CTE recompute, plus the parts. */
export interface RecomputedPostCtes {
  readonly id: string;
  readonly rising_score: number;
  readonly rising_score_updated_at: Date;
  readonly last_15m_score: number;
  readonly last_60m_score: number;
  readonly previous_60m_score: number;
  readonly acceleration_bonus: number;
}

/**
 * Recomputes one post's rising score at `now` and stores it — one
 * data-modifying `UPDATE … FROM` over chained CTEs, authored builder-native.
 */
export async function recomputePostRisingScoreCtes(
  db: PgDatabase,
  args: { readonly postId: string; readonly now: Date },
): Promise<RecomputedPostCtes> {
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

  const row = result.rows[0] as unknown as RecomputedPostCtes | undefined;
  if (row === undefined) {
    throw new Error(
      `recomputePostRisingScoreCtes: post ${args.postId} not found`,
    );
  }
  return row;
}

/**
 * Recomputes and stores the rising score for every published post at `now` —
 * one `UPDATE … FROM` over chained CTEs. Returns the number of posts updated.
 */
export async function recomputeAllRisingScoresCtes(
  db: PgDatabase,
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
    const updated = await recomputeAllRisingScoresCtes(db, { now });
    console.log(
      `recomputed rising_score (CTE strategy) for ${updated} post(s) at ${now.toISOString()}.`,
    );
  } finally {
    await db.close();
  }
}

if (import.meta.main) {
  await main();
}
