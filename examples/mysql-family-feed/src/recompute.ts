/**
 * Recomputing stored rising scores in TypeScript.
 *
 * This mirrors the SQLite-family strategy: one read for recent buckets, score
 * in TypeScript, then one batched transaction of independent UPDATEs. It is the
 * portable baseline beside the builder-native MySQL CTE path in
 * `src/recompute_ctes.ts`.
 *
 * @module
 */

import { and, eq, gte } from "@sisal/orm";
import type { MysqlDatabase } from "@sisal/mysql";
import { postActivityBuckets, posts } from "./schema.ts";
import {
  calculateRisingScore,
  mysqlTimestamp,
  type ScoredBucket,
  windowFloorMysql,
} from "./rising.ts";

/** Recomputes one post's rising score at `now` and stores it. Returns it. */
export async function recomputePostRisingScore(
  db: MysqlDatabase,
  postId: string,
  now: Date,
): Promise<number> {
  const rows = await db.select({
    bucket_start: postActivityBuckets.columns.bucket_start,
    activity_score: postActivityBuckets.columns.activity_score,
  }).from(postActivityBuckets)
    .where(and(
      eq(postActivityBuckets.columns.post_id, postId),
      gte(postActivityBuckets.columns.bucket_start, windowFloorMysql(now)),
    ))
    .execute();
  const score = calculateRisingScore(toScored(rows), now);
  await db.update(posts)
    .set({
      rising_score: score,
      rising_score_updated_at: mysqlTimestamp(now),
      updated_at: mysqlTimestamp(now),
    })
    .where(eq(posts.columns.id, postId))
    .execute();
  return score;
}

/**
 * Recomputes and stores the rising score for every published post at `now`.
 * Returns the number of posts considered.
 */
export async function recomputeAllRisingScores(
  db: MysqlDatabase,
  now: Date,
): Promise<number> {
  const postRows = await db.select({ id: posts.columns.id }).from(posts)
    .where(eq(posts.columns.status, "published"))
    .execute();
  if (postRows.length === 0) return 0;
  const ids = postRows.map((row) => row.id);

  const bucketRows = await db.select({
    post_id: postActivityBuckets.columns.post_id,
    bucket_start: postActivityBuckets.columns.bucket_start,
    activity_score: postActivityBuckets.columns.activity_score,
  }).from(postActivityBuckets)
    .where(gte(postActivityBuckets.columns.bucket_start, windowFloorMysql(now)))
    .execute();

  const byPost = new Map<string, ScoredBucket[]>();
  for (const row of bucketRows) {
    const list = byPost.get(row.post_id) ?? [];
    list.push({
      bucketStart: row.bucket_start,
      activityScore: Number(row.activity_score),
    });
    byPost.set(row.post_id, list);
  }

  const nowLiteral = mysqlTimestamp(now);
  const updates = ids.map((id) =>
    db.update(posts)
      .set({
        rising_score: calculateRisingScore(byPost.get(id) ?? [], now),
        rising_score_updated_at: nowLiteral,
        updated_at: nowLiteral,
      })
      .where(eq(posts.columns.id, id))
  );
  await db.batch(updates);
  return ids.length;
}

function toScored(
  rows: readonly { bucket_start: string; activity_score: number }[],
): ScoredBucket[] {
  return rows.map((row) => ({
    bucketStart: row.bucket_start,
    activityScore: Number(row.activity_score),
  }));
}

async function main(): Promise<void> {
  const { openDb } = await import("./db.ts");
  const db = await openDb();
  try {
    const now = new Date();
    const updated = await recomputeAllRisingScores(db, now);
    console.log(
      `recomputed rising_score for ${updated} post(s) at ${
        mysqlTimestamp(now)
      }.`,
    );
  } finally {
    await db.close();
  }
}

if (import.meta.main) {
  await main();
}
