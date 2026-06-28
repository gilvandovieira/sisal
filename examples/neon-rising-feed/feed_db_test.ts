/**
 * Database-backed integration test for the Neon rising feed.
 *
 * Gated: it only runs when `SISAL_NEON_RISING_FEED_IT=1` and `DATABASE_URL` are
 * set, mirroring the repo's `integration/` convention. It is excluded from the
 * network-free unit run (`deno task test`). It RESETS and reseeds the target
 * database, so point it at a scratch Neon branch.
 *
 *   SISAL_NEON_RISING_FEED_IT=1 \
 *     DATABASE_URL="postgres://user:pw@ep-xxx.neon.tech/db?sslmode=require" \
 *     deno test -A examples/neon-rising-feed/feed_db_test.ts
 *
 * Covers: bucket creation, unique-actor dedup, weight ordering (comments >
 * upvotes; reports penalize), stored rising_score recompute matching the
 * TypeScript model, /rising ordering, keyset pagination without duplicates,
 * moving-window decay as p_now advances, and deterministic scoring.
 *
 * @module
 */

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { sql } from "@sisal/orm";
import { connect, type NeonDatabase } from "@sisal/neon";

import {
  bucketActivityScore,
  calculateRisingScore,
  type ScoredBucket,
} from "./src/rising.ts";
import { runMigrations } from "./src/migrate.ts";
import { recordPostActivity } from "./src/activity.ts";
import {
  recomputeAllRisingScores,
  recomputePostRisingScore,
} from "./src/recompute.ts";
import { seed } from "./src/seed.ts";
import {
  type FeedPage,
  type FeedPost,
  getRisingFeed,
  type RisingCursor,
} from "./src/queries.ts";

function env(key: string): string | undefined {
  try {
    return Deno.env.get(key);
  } catch {
    return undefined;
  }
}

const URL = env("DATABASE_URL");
const SKIP = env("SISAL_NEON_RISING_FEED_IT") !== "1" || URL === undefined;

const T0 = new Date("2026-06-28T12:00:00.000Z");

function minutesAgo(n: number): Date {
  return new Date(T0.getTime() - n * 60_000);
}

async function newPost(db: NeonDatabase, title: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.execute(
    sql`insert into posts (id, title, created_at)
        values (${id}::uuid, ${title}, ${minutesAgo(30)}::timestamptz)`,
  );
  return id;
}

async function bucketRow(
  db: NeonDatabase,
  postId: string,
): Promise<
  {
    upvotes: number;
    comments: number;
    reports: number;
    unique_actors: number;
    activity_score: number;
  }
> {
  const result = await db.query<{
    upvotes: number;
    comments: number;
    reports: number;
    unique_actors: number;
    activity_score: number;
  }>(sql`
    select upvotes, comments, reports, unique_actors, activity_score
    from post_activity_buckets where post_id = ${postId}::uuid
    order by bucket_start desc limit 1
  `);
  return result.rows[0];
}

async function postScore(db: NeonDatabase, postId: string): Promise<number> {
  const result = await db.query<{ rising_score: number }>(
    sql`select rising_score from posts where id = ${postId}::uuid`,
  );
  return Number(result.rows[0].rising_score);
}

async function scoredBuckets(
  db: NeonDatabase,
  postId: string,
): Promise<ScoredBucket[]> {
  const result = await db.query<
    { bucket_start: string; activity_score: number }
  >(
    sql`select bucket_start, activity_score from post_activity_buckets
        where post_id = ${postId}::uuid`,
  );
  return result.rows.map((row) => ({
    bucketStart: new Date(row.bucket_start),
    activityScore: Number(row.activity_score),
  }));
}

Deno.test({
  name: "neon rising feed: record_post_activity + recompute + feeds",
  ignore: SKIP,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db: NeonDatabase = await connect({ url: URL! });
    try {
      await runMigrations(db, { reset: true });

      // ---- 1-3. bucket creation + unique-actor dedup -------------------
      const p1 = await newPost(db, "dedup test");
      const actorA = crypto.randomUUID();
      const actorB = crypto.randomUUID();

      const created = await recordPostActivity(db, {
        postId: p1,
        actorId: actorA,
        kind: "upvote",
        at: minutesAgo(2),
      });
      assertEquals([created.upvotes, created.unique_actors], [1, 1]); // #1

      // Same actor, same bucket: upvotes++, unique_actors unchanged.
      const again = await recordPostActivity(db, {
        postId: p1,
        actorId: actorA,
        kind: "upvote",
        at: minutesAgo(2),
      });
      assertEquals([again.upvotes, again.unique_actors], [2, 1]); // #2

      // Different actor, same bucket: both grow.
      const other = await recordPostActivity(db, {
        postId: p1,
        actorId: actorB,
        kind: "upvote",
        at: minutesAgo(2),
      });
      assertEquals([other.upvotes, other.unique_actors], [3, 2]); // #3

      // ---- 4. comments weigh more than upvotes ------------------------
      const pComment = await newPost(db, "one comment");
      await recordPostActivity(db, {
        postId: pComment,
        actorId: crypto.randomUUID(),
        kind: "comment",
        at: minutesAgo(2),
      });
      const pUpvote = await newPost(db, "one upvote");
      await recordPostActivity(db, {
        postId: pUpvote,
        actorId: crypto.randomUUID(),
        kind: "upvote",
        at: minutesAgo(2),
      });
      const commentBucket = await bucketRow(db, pComment);
      const upvoteBucket = await bucketRow(db, pUpvote);
      assert(
        commentBucket.activity_score > upvoteBucket.activity_score,
        "a comment should outweigh an upvote",
      ); // #4

      // ---- 5. reports lower activity_score ----------------------------
      const pReport = await newPost(db, "reported");
      for (let i = 0; i < 4; i += 1) {
        await recordPostActivity(db, {
          postId: pReport,
          actorId: crypto.randomUUID(),
          kind: "upvote",
          at: minutesAgo(2),
        });
      }
      const beforeReports = await bucketRow(db, pReport);
      await recordPostActivity(db, {
        postId: pReport,
        actorId: crypto.randomUUID(),
        kind: "report",
        at: minutesAgo(2),
      });
      const afterReports = await bucketRow(db, pReport);
      assert(
        afterReports.activity_score < beforeReports.activity_score,
        "a report should lower the bucket score",
      ); // #5
      // The stored bucket score matches the TypeScript weight model exactly.
      assertAlmostEquals(
        afterReports.activity_score,
        bucketActivityScore({
          upvotes: afterReports.upvotes,
          downvotes: 0,
          comments: 0,
          uniqueActors: afterReports.unique_actors,
          reports: afterReports.reports,
        }),
        1e-9,
      );

      // ---- 6 + 10. recompute updates rising_score, deterministically --
      const r1 = await recomputePostRisingScore(db, p1, T0);
      assert(r1.rising_score > 0, "p1 should have a positive rising score");
      const buckets = await scoredBuckets(db, p1);
      assertAlmostEquals(
        r1.rising_score,
        calculateRisingScore(buckets, T0),
        1e-9,
      ); // stored == TS model
      const r1again = await recomputePostRisingScore(db, p1, T0);
      assertEquals(r1again.rising_score, r1.rising_score); // #10 deterministic

      // ---- 9. old activity falls out of the window as p_now advances --
      const later = new Date(T0.getTime() + 70 * 60_000);
      const rLater = await recomputePostRisingScore(db, p1, later);
      assertEquals(rLater.rising_score, 0); // the only bucket is now ~72m old
      await recomputePostRisingScore(db, p1, T0); // restore

      // ---- 7 + 8. full dataset: ordering + pagination -----------------
      await seed(db, T0);
      const single = await getRisingFeed(db, 100);
      // Non-increasing rising_score across the feed.
      for (let i = 1; i < single.posts.length; i += 1) {
        assert(
          single.posts[i - 1].rising_score >= single.posts[i].rising_score,
          `rising_score must be non-increasing at index ${i}`,
        );
      } // #7
      // Every shown post is actually rising.
      assert(single.posts.every((p) => p.rising_score > 0));

      const paged = await collect<RisingCursor>(
        (cursor) => getRisingFeed(db, 5, cursor),
      );
      assertEquals(new Set(paged).size, paged.length); // #8 no duplicates
      assertEquals(paged, single.posts.map((p) => p.id)); // same order

      // ---- determinism across a full recompute ------------------------
      await recomputeAllRisingScores(db, T0);
      const firstPass = await postScore(db, single.posts[0].id);
      await recomputeAllRisingScores(db, T0);
      const secondPass = await postScore(db, single.posts[0].id);
      assertEquals(firstPass, secondPass);
    } finally {
      await db.close();
    }
  },
});

async function collect<TCursor>(
  fetchPage: (cursor?: TCursor) => Promise<FeedPage<TCursor>>,
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: TCursor | undefined;
  for (let guard = 0; guard < 1000; guard += 1) {
    const page = await fetchPage(cursor);
    ids.push(...page.posts.map((post: FeedPost) => post.id));
    if (page.nextCursor === undefined) break;
    cursor = page.nextCursor;
  }
  return ids;
}
