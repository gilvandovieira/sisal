/**
 * Database-backed integration tests for the MySQL-family rising feed.
 *
 * Gated on `SISAL_MYSQL_RISING_FEED_IT=1` or
 * `SISAL_MARIADB_RISING_FEED_IT=1`.
 *
 * @module
 */

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { connect, type MysqlDatabase } from "@sisal/mysql";

import {
  bucketActivityScore,
  calculateRisingScore,
  mysqlTimestamp,
  type ScoredBucket,
} from "./src/rising.ts";
import { runMigrations } from "./src/migrate.ts";
import { recordPostActivity } from "./src/activity.ts";
import {
  recomputeAllRisingScores,
  recomputePostRisingScore,
} from "./src/recompute.ts";
import {
  recomputeAllRisingScoresCtes,
  recomputePostRisingScoreCtes,
} from "./src/recompute_ctes.ts";
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

const RUN_MYSQL = env("SISAL_MYSQL_RISING_FEED_IT") === "1";
const RUN_MARIADB = env("SISAL_MARIADB_RISING_FEED_IT") === "1";
const RUN = RUN_MYSQL || RUN_MARIADB;

const T0 = new Date("2026-06-28T12:00:00.000Z");
const minutesAgo = (n: number) => new Date(T0.getTime() - n * 60_000);

async function openTestDb(): Promise<MysqlDatabase> {
  const url = RUN_MARIADB
    ? env("MARIADB_URL") ??
      "mysql://root:root@localhost:33110/sisal"
    : env("MYSQL_URL") ??
      "mysql://root:root@localhost:33084/sisal";
  const driver = env("SISAL_ADAPTER") === "mariadb" || RUN_MARIADB
    ? "mariadb"
    : "mysql2";
  return await connect({ url, driver });
}

async function insertPost(db: MysqlDatabase, title: string): Promise<string> {
  const { posts } = await import("./src/schema.ts");
  const id = crypto.randomUUID();
  const created = mysqlTimestamp(minutesAgo(30));
  await db.insert(posts).values({
    id,
    title,
    rising_score_updated_at: null,
    created_at: created,
    updated_at: created,
  }).execute();
  return id;
}

async function latestBucket(
  db: MysqlDatabase,
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

async function postScore(db: MysqlDatabase, postId: string): Promise<number> {
  const { posts } = await import("./src/schema.ts");
  const { eq } = await import("@sisal/orm");
  const rows = await db.select({ rising_score: posts.columns.rising_score })
    .from(posts).where(eq(posts.columns.id, postId)).execute();
  return Number(rows[0].rising_score);
}

Deno.test({
  name: "mysql-family rising feed: record + recompute + feeds",
  ignore: !RUN,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = await openTestDb();
    try {
      await runMigrations(db, { reset: true });

      const p1 = await insertPost(db, "dedup test");
      const actorA = crypto.randomUUID();
      const actorB = crypto.randomUUID();

      const created = await recordPostActivity(db, {
        postId: p1,
        actorId: actorA,
        kind: "upvote",
        at: minutesAgo(2),
      });
      assertEquals([created.upvotes, created.unique_actors], [1, 1]);

      const again = await recordPostActivity(db, {
        postId: p1,
        actorId: actorA,
        kind: "upvote",
        at: minutesAgo(2),
      });
      assertEquals([again.upvotes, again.unique_actors], [2, 1]);

      const other = await recordPostActivity(db, {
        postId: p1,
        actorId: actorB,
        kind: "upvote",
        at: minutesAgo(2),
      });
      assertEquals([other.upvotes, other.unique_actors], [3, 2]);

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
      );

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
      assert(after.activity_score < before.activity_score);
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

      const r1 = await recomputePostRisingScore(db, p1, T0);
      assert(r1 > 0, "p1 should have a positive rising score");
      assertEquals(await recomputePostRisingScore(db, p1, T0), r1);
      assertEquals(await postScore(db, p1), r1);

      const cte = await recomputePostRisingScoreCtes(db, {
        postId: p1,
        now: T0,
      });
      assertAlmostEquals(cte.rising_score, r1, 1e-9);

      const later = new Date(T0.getTime() + 70 * 60_000);
      const rLater = await recomputePostRisingScore(db, p1, later);
      assertEquals(rLater, 0);
      await recomputePostRisingScore(db, p1, T0);

      await seed(db, T0);
      const single = await getRisingFeed(db, 100);
      for (let i = 1; i < single.posts.length; i += 1) {
        assert(
          single.posts[i - 1].rising_score >= single.posts[i].rising_score,
          `rising_score must be non-increasing at index ${i}`,
        );
      }
      assert(single.posts.every((p) => p.rising_score > 0));

      const paged = await collect<RisingCursor>(
        (cursor) => getRisingFeed(db, 5, cursor),
      );
      assertEquals(new Set(paged).size, paged.length);
      assertEquals(paged, single.posts.map((p) => p.id));

      await recomputeAllRisingScores(db, T0);
      const first = await postScore(db, single.posts[0].id);
      await recomputeAllRisingScoresCtes(db, { now: T0 });
      assertAlmostEquals(await postScore(db, single.posts[0].id), first, 1e-9);
    } finally {
      await db.close();
    }
  },
});

Deno.test({
  name: "mysql-family rising feed: future and old buckets do not count",
  ignore: !RUN,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = await openTestDb();
    try {
      await runMigrations(db, { reset: true });

      const postId = await insertPost(db, "future + old buckets");

      await recordPostActivity(db, {
        postId,
        actorId: crypto.randomUUID(),
        kind: "upvote",
        at: minutesAgo(2),
      });
      for (let i = 0; i < 5; i += 1) {
        await recordPostActivity(db, {
          postId,
          actorId: crypto.randomUUID(),
          kind: "comment",
          at: new Date(T0.getTime() + 10 * 60_000),
        });
      }
      for (let i = 0; i < 5; i += 1) {
        await recordPostActivity(db, {
          postId,
          actorId: crypto.randomUUID(),
          kind: "upvote",
          at: minutesAgo(200),
        });
      }

      const single = await recomputePostRisingScore(db, postId, T0);
      const buckets = await allBucketsFor(db, postId);
      assertAlmostEquals(single, calculateRisingScore(buckets, T0), 1e-9);
      assertAlmostEquals(single, 18, 1e-9);
      assertAlmostEquals(await postScore(db, postId), single, 1e-9);

      await recomputeAllRisingScoresCtes(db, { now: T0 });
      assertAlmostEquals(await postScore(db, postId), single, 1e-9);
    } finally {
      await db.close();
    }
  },
});

async function allBucketsFor(
  db: MysqlDatabase,
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
