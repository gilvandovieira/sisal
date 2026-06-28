/**
 * Database-backed integration test for the normal-PostgreSQL rising feed.
 *
 * Gated: it only runs when `SISAL_POSTGRES_RISING_FEED_IT=1` and `DATABASE_URL`
 * are set, mirroring the repo's `integration/` convention. It is excluded from
 * the network-free unit run (`deno task test`). It RESETS and reseeds the target
 * database, so point it at a scratch local PostgreSQL.
 *
 *   docker compose up -d
 *   SISAL_POSTGRES_RISING_FEED_IT=1 \
 *     DATABASE_URL="postgres://sisal:sisal@localhost:5432/sisal_rising_feed" \
 *     deno test -A feed_db_test.ts
 *   docker compose down -v
 *
 * Covers: bucket creation, unique-actor dedup, weight ordering (comments >
 * upvotes; reports penalize), stored rising_score recompute matching the
 * TypeScript model, /rising ordering, keyset pagination without duplicates,
 * moving-window decay as p_now advances, future buckets excluded, deterministic
 * scoring, and that the optional interactive-transaction recorder agrees with
 * the database-function recorder.
 *
 * @module
 */

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { sql } from "@sisal/orm";
import { connect, type PgDatabase } from "@sisal/pg";

import {
  bucketActivityScore,
  calculateRisingScore,
  type ScoredBucket,
} from "./src/rising.ts";
import { runMigrations } from "./src/migrate.ts";
import {
  recordPostActivity,
  recordPostActivityWithTransaction,
} from "./src/activity.ts";
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
const SKIP = env("SISAL_POSTGRES_RISING_FEED_IT") !== "1" || URL === undefined;

const T0 = new Date("2026-06-28T12:00:00.000Z");

function minutesAgo(n: number): Date {
  return new Date(T0.getTime() - n * 60_000);
}

async function newPost(db: PgDatabase, title: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.execute(
    sql`insert into posts (id, title, created_at)
        values (${id}::uuid, ${title}, ${minutesAgo(30)}::timestamptz)`,
  );
  return id;
}

interface BucketCols {
  upvotes: number;
  comments: number;
  reports: number;
  unique_actors: number;
  activity_score: number;
}

async function latestBucket(
  db: PgDatabase,
  postId: string,
): Promise<BucketCols> {
  const result = await db.query<BucketCols>(sql`
    select upvotes, comments, reports, unique_actors, activity_score
    from post_activity_buckets where post_id = ${postId}::uuid
    order by bucket_start desc limit 1
  `);
  const row = result.rows[0];
  // @sisal/pg returns double precision as a string; coerce activity_score.
  return { ...row, activity_score: Number(row.activity_score) };
}

async function postScore(db: PgDatabase, postId: string): Promise<number> {
  const result = await db.query<{ rising_score: number }>(
    sql`select rising_score from posts where id = ${postId}::uuid`,
  );
  return Number(result.rows[0].rising_score);
}

async function scoredBuckets(
  db: PgDatabase,
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
  name: "postgres rising feed: record_post_activity + recompute + feeds",
  ignore: SKIP,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db: PgDatabase = await connect({ url: URL! });
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
      assert(
        (await latestBucket(db, pComment)).activity_score >
          (await latestBucket(db, pUpvote)).activity_score,
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
      const before = await latestBucket(db, pReport);
      await recordPostActivity(db, {
        postId: pReport,
        actorId: crypto.randomUUID(),
        kind: "report",
        at: minutesAgo(2),
      });
      const after = await latestBucket(db, pReport);
      assert(after.activity_score < before.activity_score); // #5
      assertAlmostEquals(
        after.activity_score,
        bucketActivityScore({
          upvotes: after.upvotes,
          downvotes: 0,
          comments: 0,
          uniqueActors: after.unique_actors,
          reports: after.reports,
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
      assertEquals(await postScore(db, p1), r1.rising_score); // stored

      // ---- 9. old activity falls out of the window as p_now advances --
      const later = new Date(T0.getTime() + 70 * 60_000);
      const rLater = await recomputePostRisingScore(db, p1, later);
      assertEquals(rLater.rising_score, 0); // the only bucket is now ~72m old
      await recomputePostRisingScore(db, p1, T0); // restore

      // ---- 7 + 8. full dataset: ordering + pagination -----------------
      await seed(db, T0);
      const single = await getRisingFeed(db, 100);
      for (let i = 1; i < single.posts.length; i += 1) {
        assert(
          single.posts[i - 1].rising_score >= single.posts[i].rising_score,
          `rising_score must be non-increasing at index ${i}`,
        );
      } // #7
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

Deno.test({
  name: "postgres rising feed: future and old buckets do not count",
  ignore: SKIP,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db: PgDatabase = await connect({ url: URL! });
    try {
      await runMigrations(db, { reset: true });

      const postId = await newPost(db, "future + old buckets");

      // In-window: 1 upvote ~2m ago → contributes (activity_score 3).
      await recordPostActivity(db, {
        postId,
        actorId: crypto.randomUUID(),
        kind: "upvote",
        at: minutesAgo(2),
      });
      // Future: a big comment burst dated AFTER p_now. Must NOT count.
      for (let i = 0; i < 5; i += 1) {
        await recordPostActivity(db, {
          postId,
          actorId: crypto.randomUUID(),
          kind: "comment",
          at: new Date(T0.getTime() + 10 * 60_000),
        });
      }
      // Old: a big burst > 120m ago. Must NOT count.
      for (let i = 0; i < 5; i += 1) {
        await recordPostActivity(db, {
          postId,
          actorId: crypto.randomUUID(),
          kind: "upvote",
          at: minutesAgo(200),
        });
      }

      const r = await recomputePostRisingScore(db, postId, T0);
      // The DB function and the TypeScript model agree over the SAME buckets:
      // both ignore the future and old buckets, so only the in-window one counts.
      const buckets = await scoredBuckets(db, postId);
      assertAlmostEquals(
        r.rising_score,
        calculateRisingScore(buckets, T0),
        1e-9,
      );
      // Only the in-window bucket counted: last_15m=last_60m=3, accel=3 ⇒ 18.
      assertAlmostEquals(r.rising_score, 18, 1e-9);
    } finally {
      await db.close();
    }
  },
});

Deno.test({
  name: "postgres rising feed: interactive-transaction recorder agrees",
  ignore: SKIP,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db: PgDatabase = await connect({ url: URL! });
    try {
      await runMigrations(db, { reset: true });

      // Same activity sequence on two posts: one via the database function,
      // one via the interactive transaction. They must produce identical
      // buckets, proving normal Postgres can do both.
      const events: Array<{ actor: string; kind: "upvote" | "comment" }> = [
        { actor: "a", kind: "upvote" },
        { actor: "a", kind: "upvote" }, // dedup: same actor, no new unique
        { actor: "b", kind: "comment" },
        { actor: "c", kind: "upvote" },
      ];

      const viaFn = await newPost(db, "via function");
      const viaTx = await newPost(db, "via transaction");
      const actors = new Map<string, string>();
      const actorId = (k: string) => {
        const existing = actors.get(k);
        if (existing) return existing;
        const id = crypto.randomUUID();
        actors.set(k, id);
        return id;
      };

      for (const e of events) {
        await recordPostActivity(db, {
          postId: viaFn,
          actorId: actorId(`fn-${e.actor}`),
          kind: e.kind,
          at: minutesAgo(2),
        });
        await recordPostActivityWithTransaction(db, {
          postId: viaTx,
          actorId: actorId(`tx-${e.actor}`),
          kind: e.kind,
          at: minutesAgo(2),
        });
      }

      const fnBucket = await latestBucket(db, viaFn);
      const txBucket = await latestBucket(db, viaTx);
      assertEquals(
        [fnBucket.upvotes, fnBucket.comments, fnBucket.unique_actors],
        [txBucket.upvotes, txBucket.comments, txBucket.unique_actors],
      );
      assertAlmostEquals(
        fnBucket.activity_score,
        txBucket.activity_score,
        1e-9,
      );
      // 3 upvotes + 1 comment, 3 unique actors → 3 + 3 + 3*2 = 12.
      assertAlmostEquals(fnBucket.activity_score, 12, 1e-9);
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
