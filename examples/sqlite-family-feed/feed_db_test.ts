/**
 * Database-backed integration test for the libSQL rising feed.
 *
 * Gated on `SISAL_LIBSQL_RISING_FEED_IT=1`, mirroring the repo's libSQL
 * integration convention: it uses a temp `file:` database by default, or a real
 * Turso endpoint if `TURSO_DATABASE_URL` (+ `TURSO_AUTH_TOKEN`) are set. It is
 * excluded from the network-free unit run (`deno task test`).
 *
 *   SISAL_LIBSQL_RISING_FEED_IT=1 deno test -A examples/libsql-rising-feed/feed_db_test.ts
 *
 * Covers: bucket creation, unique-actor dedup, weight ordering (comments >
 * upvotes; reports penalize), rising_score recompute matching the model,
 * /rising ordering, keyset pagination without duplicates, moving-window decay,
 * and deterministic scoring.
 *
 * @module
 */

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { connect, type LibsqlDatabase } from "@sisal/libsql";

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

const RUN = env("SISAL_LIBSQL_RISING_FEED_IT") === "1";
const REMOTE_URL = env("TURSO_DATABASE_URL");
const AUTH_TOKEN = env("TURSO_AUTH_TOKEN");

const T0 = new Date("2026-06-28T12:00:00.000Z");
const minutesAgo = (n: number) => new Date(T0.getTime() - n * 60_000);

async function openTestDb(): Promise<{ db: LibsqlDatabase; url: string }> {
  const url = REMOTE_URL ??
    `file:${await Deno.makeTempFile({ suffix: ".db" })}`;
  const db = await connect(
    AUTH_TOKEN === undefined ? { url } : { url, authToken: AUTH_TOKEN },
  );
  return { db, url };
}

async function insertPost(db: LibsqlDatabase, title: string): Promise<string> {
  const { posts } = await import("./src/schema.ts");
  const id = crypto.randomUUID();
  const iso = minutesAgo(30).toISOString();
  await db.insert(posts).values({
    id,
    title,
    rising_score_updated_at: null,
    created_at: iso,
    updated_at: iso,
  }).execute();
  return id;
}

async function latestBucket(
  db: LibsqlDatabase,
  postId: string,
): Promise<{ upvotes: number; unique_actors: number; activity_score: number }> {
  const { postActivityBuckets } = await import("./src/schema.ts");
  const { desc, eq } = await import("@sisal/orm");
  const rows = await db.select().from(postActivityBuckets)
    .where(eq(postActivityBuckets.columns.post_id, postId))
    .orderBy(desc(postActivityBuckets.columns.bucket_start))
    .limit(1)
    .execute();
  const row = rows[0];
  return {
    upvotes: Number(row.upvotes),
    unique_actors: Number(row.unique_actors),
    activity_score: Number(row.activity_score),
  };
}

async function postScore(db: LibsqlDatabase, postId: string): Promise<number> {
  const { posts } = await import("./src/schema.ts");
  const { eq } = await import("@sisal/orm");
  const rows = await db.select({ rising_score: posts.columns.rising_score })
    .from(posts).where(eq(posts.columns.id, postId)).execute();
  return Number(rows[0].rising_score);
}

Deno.test({
  name: "libsql rising feed: record + recompute + feeds",
  ignore: !RUN,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { db, url } = await openTestDb();
    try {
      await runMigrations(db, { reset: true });

      // ---- 1-3. bucket creation + unique-actor dedup ------------------
      const p1 = await insertPost(db, "dedup test");
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
      const pComment = await insertPost(db, "one comment");
      await recordPostActivity(db, {
        postId: pComment,
        actorId: crypto.randomUUID(),
        kind: "comment",
        at: minutesAgo(2),
      });
      const pUpvote = await insertPost(db, "one upvote");
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

      // ---- 5. reports lower activity_score ---------------------------
      const pReport = await insertPost(db, "reported");
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
          reports: 1,
        }),
        1e-9,
      );

      // ---- 6 + 10. recompute updates rising_score, deterministically -
      const r1 = await recomputePostRisingScore(db, p1, T0);
      assert(r1 > 0, "p1 should have a positive rising score");
      const r1again = await recomputePostRisingScore(db, p1, T0);
      assertEquals(r1again, r1); // #10 deterministic
      assertEquals(await postScore(db, p1), r1); // #6 stored

      // ---- 9. old activity falls out of the window -------------------
      const later = new Date(T0.getTime() + 70 * 60_000);
      const rLater = await recomputePostRisingScore(db, p1, later);
      assertEquals(rLater, 0); // the only bucket is now ~72m old
      await recomputePostRisingScore(db, p1, T0); // restore

      // ---- 7 + 8. full dataset: ordering + pagination ----------------
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

      // ---- determinism across a full recompute ----------------------
      await recomputeAllRisingScores(db, T0);
      const first = await postScore(db, single.posts[0].id);
      await recomputeAllRisingScores(db, T0);
      assertEquals(await postScore(db, single.posts[0].id), first);
    } finally {
      await db.close();
      if (REMOTE_URL === undefined && url.startsWith("file:")) {
        try {
          await Deno.remove(url.slice("file:".length));
        } catch { /* ignore */ }
      }
    }
  },
});

Deno.test({
  name: "libsql rising feed: future and old buckets do not count",
  ignore: !RUN,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { db, url } = await openTestDb();
    try {
      await runMigrations(db, { reset: true });

      const postId = await insertPost(db, "future + old buckets");

      // In-window: 1 upvote ~2m ago → contributes (activity_score 3).
      await recordPostActivity(db, {
        postId,
        actorId: crypto.randomUUID(),
        kind: "upvote",
        at: minutesAgo(2),
      });
      // Future: a big comment burst dated AFTER now. Must NOT count.
      for (let i = 0; i < 5; i += 1) {
        await recordPostActivity(db, {
          postId,
          actorId: crypto.randomUUID(),
          kind: "comment",
          at: new Date(T0.getTime() + 10 * 60_000),
        });
      }
      // Old: a big burst > 120m ago. Must NOT count, and must not be scanned by
      // the single-post recompute (it reads only the 120-minute window).
      for (let i = 0; i < 5; i += 1) {
        await recordPostActivity(db, {
          postId,
          actorId: crypto.randomUUID(),
          kind: "upvote",
          at: minutesAgo(200),
        });
      }

      // Single-post recompute reads only the window, yet its result equals the
      // TypeScript model over EVERY bucket (which ignores future + old) — so old
      // buckets neither affect the score nor need scanning.
      const single = await recomputePostRisingScore(db, postId, T0);
      const buckets = await allBucketsFor(db, postId);
      assertAlmostEquals(single, calculateRisingScore(buckets, T0), 1e-9);
      // Only the in-window bucket counted: last_15m=last_60m=3, accel=3 ⇒ 18.
      assertAlmostEquals(single, 18, 1e-9);
      assertAlmostEquals(await postScore(db, postId), single, 1e-9);

      // Single-post and all-post recompute agree for the same data + now.
      await recomputeAllRisingScores(db, T0);
      assertAlmostEquals(await postScore(db, postId), single, 1e-9);
    } finally {
      await db.close();
      if (REMOTE_URL === undefined && url.startsWith("file:")) {
        try {
          await Deno.remove(url.slice("file:".length));
        } catch { /* ignore */ }
      }
    }
  },
});

async function allBucketsFor(
  db: LibsqlDatabase,
  postId: string,
): Promise<ScoredBucket[]> {
  const { postActivityBuckets } = await import("./src/schema.ts");
  const { eq } = await import("@sisal/orm");
  const rows = await db.select({
    bucket_start: postActivityBuckets.columns.bucket_start,
    activity_score: postActivityBuckets.columns.activity_score,
  }).from(postActivityBuckets)
    .where(eq(postActivityBuckets.columns.post_id, postId))
    .execute();
  return rows.map((row) => ({
    bucketStart: row.bucket_start,
    activityScore: Number(row.activity_score),
  }));
}

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
