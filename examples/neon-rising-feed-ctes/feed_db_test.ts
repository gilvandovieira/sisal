/**
 * Database-backed integration test for the Neon rising feed (CTE variant).
 *
 * Gated: it only runs when `SISAL_NEON_RISING_CTE_FEED_IT=1` and `DATABASE_URL`
 * are set, mirroring the repo's `integration/` convention. It is excluded from
 * the network-free unit run (`deno task test`). It RESETS and reseeds the target
 * database, so point it at a scratch Neon branch (or local Postgres).
 *
 *   SISAL_NEON_RISING_CTE_FEED_IT=1 \
 *     DATABASE_URL="postgres://user:pw@ep-xxx.neon.tech/db?sslmode=require" \
 *     deno test -A feed_db_test.ts
 *
 * Covers: the recording CTE (bucket creation, unique-actor dedup, weight
 * ordering, report penalty), the recompute CTEs (per-post + bulk), `/rising`
 * ordering, keyset pagination without duplicates, moving-window decay + future
 * exclusion, deterministic scoring, and invalid-kind rejection.
 *
 * @module
 */

import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertRejects,
} from "@std/assert";
import { sql } from "@sisal/orm";
import { connect, type NeonDatabase } from "@sisal/neon";

import { recordPostActivity } from "./src/activity.ts";
import {
  type ActivityKind,
  calculateRisingScoreTs,
  recomputeAllRisingScores,
  recomputePostRisingScore,
  type ScoredBucket,
} from "./src/rising.ts";
import { runMigrations } from "./src/migrate.ts";
import { seed } from "./src/seed.ts";
import {
  type FeedPage,
  type FeedPost,
  getRisingFeed,
  type RisingCursor,
  selectRisingScore,
} from "./src/queries.ts";

function env(key: string): string | undefined {
  try {
    return Deno.env.get(key);
  } catch {
    return undefined;
  }
}

const URL = env("DATABASE_URL");
const SKIP = env("SISAL_NEON_RISING_CTE_FEED_IT") !== "1" || URL === undefined;

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
  name: "neon rising (CTE): record + recompute + feeds",
  ignore: SKIP,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db: NeonDatabase = await connect({ url: URL! });
    try {
      await runMigrations(db, { reset: true });

      // ---- 1-3. bucket creation + unique-actor dedup ------------------
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

      const again = await recordPostActivity(db, {
        postId: p1,
        actorId: actorA,
        kind: "upvote",
        at: minutesAgo(2),
      });
      assertEquals([again.upvotes, again.unique_actors], [2, 1]); // #2

      const other = await recordPostActivity(db, {
        postId: p1,
        actorId: actorB,
        kind: "upvote",
        at: minutesAgo(2),
      });
      assertEquals([other.upvotes, other.unique_actors], [3, 2]); // #3

      // ---- 4. comments weigh more than upvotes -----------------------
      const pComment = await newPost(db, "one comment");
      const commentBucket = await recordPostActivity(db, {
        postId: pComment,
        actorId: crypto.randomUUID(),
        kind: "comment",
        at: minutesAgo(2),
      });
      const pUpvote = await newPost(db, "one upvote");
      const upvoteBucket = await recordPostActivity(db, {
        postId: pUpvote,
        actorId: crypto.randomUUID(),
        kind: "upvote",
        at: minutesAgo(2),
      });
      assert(
        Number(commentBucket.activity_score) >
          Number(upvoteBucket.activity_score),
        "a comment should outweigh an upvote",
      ); // #4

      // ---- 5. reports lower activity_score ---------------------------
      const pReport = await newPost(db, "reported");
      let beforeReport = 0;
      for (let i = 0; i < 4; i += 1) {
        const b = await recordPostActivity(db, {
          postId: pReport,
          actorId: crypto.randomUUID(),
          kind: "upvote",
          at: minutesAgo(2),
        });
        beforeReport = Number(b.activity_score);
      }
      const afterReport = await recordPostActivity(db, {
        postId: pReport,
        actorId: crypto.randomUUID(),
        kind: "report",
        at: minutesAgo(2),
      });
      assert(Number(afterReport.activity_score) < beforeReport); // #5

      // ---- 6 + 11. recompute updates rising_score, deterministically -
      const r1 = await recomputePostRisingScore(db, { postId: p1, now: T0 });
      assert(r1.rising_score > 0, "p1 should have a positive rising score");
      const buckets = await scoredBuckets(db, p1);
      assertAlmostEquals(
        r1.rising_score,
        calculateRisingScoreTs(buckets, T0),
        1e-9,
      ); // stored == TS model
      const r1again = await recomputePostRisingScore(db, {
        postId: p1,
        now: T0,
      });
      assertEquals(r1again.rising_score, r1.rising_score); // #11 deterministic
      assertEquals(await postScore(db, p1), r1.rising_score); // stored

      // ---- 8 + 9. full dataset: ordering + pagination ----------------
      await seed(db, T0);
      const single = await getRisingFeed(db, 100);
      for (let i = 1; i < single.posts.length; i += 1) {
        assert(
          single.posts[i - 1].rising_score >= single.posts[i].rising_score,
          `rising_score must be non-increasing at index ${i}`,
        );
      } // #8
      assert(single.posts.every((p) => p.rising_score > 0));

      const paged = await collect<RisingCursor>(
        (cursor) => getRisingFeed(db, 5, cursor),
      );
      assertEquals(new Set(paged).size, paged.length); // #9 no duplicates
      assertEquals(paged, single.posts.map((p) => p.id)); // same order
    } finally {
      await db.close();
    }
  },
});

Deno.test({
  name: "neon rising (CTE): bulk recompute, decay, future exclusion",
  ignore: SKIP,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db: NeonDatabase = await connect({ url: URL! });
    try {
      await runMigrations(db, { reset: true });

      // ---- 7. recomputeAllRisingScores updates multiple posts --------
      const seeded = await seed(db, T0);
      const updated = await recomputeAllRisingScores(db, { now: T0 });
      assertEquals(updated, seeded.length); // every published post updated

      // ---- 10 + future: window decay and future-bucket exclusion -----
      const postId = await newPost(db, "future + old");
      // in-window
      await recordPostActivity(db, {
        postId,
        actorId: crypto.randomUUID(),
        kind: "upvote",
        at: minutesAgo(2),
      });
      // future (must NOT count)
      for (let i = 0; i < 5; i += 1) {
        await recordPostActivity(db, {
          postId,
          actorId: crypto.randomUUID(),
          kind: "comment",
          at: new Date(T0.getTime() + 10 * 60_000),
        });
      }
      // old (> 120m, must NOT count)
      for (let i = 0; i < 5; i += 1) {
        await recordPostActivity(db, {
          postId,
          actorId: crypto.randomUUID(),
          kind: "upvote",
          at: minutesAgo(200),
        });
      }
      const atNow = await recomputePostRisingScore(db, { postId, now: T0 });
      const allBuckets = await scoredBuckets(db, postId);
      // DB result == TS model over the same buckets (both ignore future + old).
      assertAlmostEquals(
        atNow.rising_score,
        calculateRisingScoreTs(allBuckets, T0),
        1e-9,
      );
      // Only the in-window bucket counts: 1 upvote + 1 unique ⇒ 3; rising 18.
      // (The future bucket is excluded relative to T0; it would legitimately
      // re-enter the window at a later p_now — see the decay post below, which
      // has ONLY an in-window bucket so it cleanly decays to 0.)
      assertAlmostEquals(atNow.rising_score, 18, 1e-9);

      // The builder-native read (filter + dateSub, v0.5.0 item 9) computes the
      // same windows as the raw-SQL CTE over the same data — the moving-window
      // aggregate no longer needs the escape hatch.
      const builderNative = await selectRisingScore(db, { postId, now: T0 });
      assertAlmostEquals(builderNative.rising_score, atNow.rising_score, 1e-9);
      assertAlmostEquals(
        builderNative.last_15m_score,
        atNow.last_15m_score,
        1e-9,
      );
      assertAlmostEquals(
        builderNative.previous_60m_score,
        atNow.previous_60m_score,
        1e-9,
      );

      // ---- 10. window decay: a post with ONLY a recent bucket falls to 0 --
      const decayPost = await newPost(db, "decays");
      await recordPostActivity(db, {
        postId: decayPost,
        actorId: crypto.randomUUID(),
        kind: "upvote",
        at: minutesAgo(2),
      });
      const decayNow = await recomputePostRisingScore(db, {
        postId: decayPost,
        now: T0,
      });
      assert(decayNow.rising_score > 0);
      // 70 minutes later the only bucket is ~72m old → all score-driving
      // windows are empty, so rising_score decays to 0.
      const decayLater = await recomputePostRisingScore(db, {
        postId: decayPost,
        now: new Date(T0.getTime() + 70 * 60_000),
      });
      assertEquals(decayLater.rising_score, 0); // #10
    } finally {
      await db.close();
    }
  },
});

Deno.test({
  name: "neon rising (CTE): invalid kind is rejected",
  ignore: SKIP,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db: NeonDatabase = await connect({ url: URL! });
    try {
      await runMigrations(db, { reset: true });
      const postId = await newPost(db, "invalid kind");
      // The CTE filters invalid kinds → no rows → the wrapper throws. #12
      await assertRejects(() =>
        recordPostActivity(db, {
          postId,
          actorId: crypto.randomUUID(),
          kind: "spam" as ActivityKind,
          at: minutesAgo(2),
        })
      );
      // No bucket was created.
      const buckets = await scoredBuckets(db, postId);
      assertEquals(buckets.length, 0);
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
