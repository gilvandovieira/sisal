/**
 * Recomputing stored rising scores — in TypeScript, because SQLite has no
 * stored procedures.
 *
 * The Neon sibling recomputes every post with one statement
 * (`update posts set rising_score = app.calculate_rising_score(id, now)`).
 * Without a SQL function, this version:
 *
 *   1. reads all recent buckets in ONE query (everything inside the 120-minute
 *      window, across all posts);
 *   2. computes each post's score in TypeScript with `calculateRisingScore`;
 *   3. writes the scores back with `db.batch([...])` — one atomic,
 *      non-interactive transaction of independent UPDATEs (ideal for serverless
 *      because no connection is held open across the round trip).
 *
 * Posts with no recent activity are set to 0 so the stored value never goes
 * stale. `now` is explicit so recomputes are deterministic.
 *
 * @module
 */

import { and, eq, gte } from "@sisal/orm";
import type { LibsqlDatabase } from "@sisal/libsql";
import { postActivityBuckets, posts } from "./schema.ts";
import {
  calculateRisingScore,
  type ScoredBucket,
  windowFloorIso,
} from "./rising.ts";

/** Recomputes one post's rising score at `now` and stores it. Returns it. */
export async function recomputePostRisingScore(
  db: LibsqlDatabase,
  postId: string,
  now: Date,
): Promise<number> {
  // Read only buckets that can affect the score — the same 120-minute window
  // floor the all-post path uses. Buckets older than this can't enter any
  // window, so there's no need to scan them; future buckets are excluded by
  // calculateRisingScore's per-window upper bound.
  const rows = await db.select({
    bucket_start: postActivityBuckets.columns.bucket_start,
    activity_score: postActivityBuckets.columns.activity_score,
  }).from(postActivityBuckets)
    .where(and(
      eq(postActivityBuckets.columns.post_id, postId),
      gte(postActivityBuckets.columns.bucket_start, windowFloorIso(now)),
    ))
    .execute();
  const score = calculateRisingScore(toScored(rows), now);
  await db.update(posts)
    .set({ rising_score: score, rising_score_updated_at: now.toISOString() })
    .where(eq(posts.columns.id, postId))
    .execute();
  return score;
}

/**
 * Recomputes and stores the rising score for every published post at `now`.
 * Returns the number of posts updated.
 */
export async function recomputeAllRisingScores(
  db: LibsqlDatabase,
  now: Date,
): Promise<number> {
  // All published post ids.
  const postRows = await db.select({ id: posts.columns.id }).from(posts)
    .where(eq(posts.columns.status, "published"))
    .execute();
  if (postRows.length === 0) return 0;
  const ids = postRows.map((row) => row.id);

  // One read for every recent bucket across all those posts.
  const bucketRows = await db.select({
    post_id: postActivityBuckets.columns.post_id,
    bucket_start: postActivityBuckets.columns.bucket_start,
    activity_score: postActivityBuckets.columns.activity_score,
  }).from(postActivityBuckets)
    .where(gte(postActivityBuckets.columns.bucket_start, windowFloorIso(now)))
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

  // One UPDATE per post, submitted as a single atomic, non-interactive batch.
  const nowIso = now.toISOString();
  const updates = ids.map((id) =>
    db.update(posts)
      .set({
        rising_score: calculateRisingScore(byPost.get(id) ?? [], now),
        rising_score_updated_at: nowIso,
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
      `recomputed rising_score for ${updated} post(s) at ${now.toISOString()}.`,
    );
  } finally {
    await db.close();
  }
}

if (import.meta.main) {
  await main();
}
