/**
 * Database-backed integration test for the Neon hot feed.
 *
 * Gated: it only runs when `SISAL_NEON_HOT_FEED_IT=1` and `DATABASE_URL` are
 * set, mirroring the repo's `integration/` convention. It is excluded from the
 * network-free unit run (`deno task test`). It RESETS and reseeds the target
 * database, so point it at a scratch Neon branch.
 *
 *   SISAL_NEON_HOT_FEED_IT=1 \
 *     DATABASE_URL="postgres://user:pw@ep-xxx.neon.tech/db?sslmode=require" \
 *     deno test -A examples/postgres-family-hot-feed/feed_db_test.ts
 *
 * Covers: vote_post create / switch / remove, score+aggregate consistency,
 * stored hot_score matching the TypeScript model, stable hot ordering, and
 * keyset pagination producing no duplicates across pages.
 *
 * @module
 */

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { sql } from "@sisal/orm";
import { connect, type NeonDatabase } from "@sisal/neon";

import { calculateHotScore } from "./src/hot.ts";
import { runMigrations } from "./src/migrate.ts";
import { seed } from "./src/seed.ts";
import {
  type FeedPage,
  type FeedPost,
  getHotFeed,
  getNewFeed,
  type HotCursor,
  type NewCursor,
} from "./src/queries.ts";
import { votePost } from "./src/vote.ts";

function env(key: string): string | undefined {
  try {
    return Deno.env.get(key);
  } catch {
    return undefined;
  }
}

const URL = env("DATABASE_URL");
const SKIP = env("SISAL_NEON_HOT_FEED_IT") !== "1" || URL === undefined;

async function collect<TCursor>(
  fetchPage: (cursor?: TCursor) => Promise<FeedPage<TCursor>>,
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: TCursor | undefined;
  for (let guard = 0; guard < 1000; guard += 1) {
    const page = await fetchPage(cursor);
    ids.push(...page.posts.map((post) => post.id));
    if (page.nextCursor === undefined) break;
    cursor = page.nextCursor;
  }
  return ids;
}

function assertNonIncreasing(rows: readonly FeedPost[]): void {
  for (let i = 1; i < rows.length; i += 1) {
    assert(
      rows[i - 1].hot_score >= rows[i].hot_score,
      `hot_score must be non-increasing at index ${i}`,
    );
  }
}

Deno.test({
  name: "neon hot feed: vote_post + feeds end to end",
  ignore: SKIP,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db: NeonDatabase = await connect({ url: URL! });
    try {
      await runMigrations(db, { reset: true });

      // ---- app.vote_post: create / switch / remove --------------------
      const postId = crypto.randomUUID();
      await db.execute(
        sql`insert into posts (id, title) values (${postId}::uuid, ${"vote test"})`,
      );
      const created = await db.query<{ created_at: Date }>(
        sql`select created_at from posts where id = ${postId}::uuid`,
      );
      const createdAt = created.rows[0].created_at;

      const userId = crypto.randomUUID();

      const up = await votePost(db, postId, userId, 1);
      assertEquals([up.upvotes, up.downvotes, up.score], [1, 0, 1]);
      assertAlmostEquals(up.hot_score, calculateHotScore(1, createdAt), 1e-6);

      const switched = await votePost(db, postId, userId, -1);
      assertEquals(
        [switched.upvotes, switched.downvotes, switched.score],
        [0, 1, -1],
      );
      assertAlmostEquals(
        switched.hot_score,
        calculateHotScore(-1, createdAt),
        1e-6,
      );

      const removed = await votePost(db, postId, userId, 0);
      assertEquals([removed.upvotes, removed.downvotes, removed.score], [
        0,
        0,
        0,
      ]);
      assertAlmostEquals(
        removed.hot_score,
        calculateHotScore(0, createdAt),
        1e-6,
      );

      // No stored vote row remains after removal.
      const remaining = await db.query<{ n: number }>(
        sql`select count(*)::int as n from post_votes where post_id = ${postId}::uuid`,
      );
      assertEquals(Number(remaining.rows[0].n), 0);

      // ---- aggregate consistency across the whole dataset -------------
      await seed(db);
      const mismatched = await db.query<{ n: number }>(sql`
        select count(*)::int as n from posts p
        where p.score <> p.upvotes - p.downvotes
           or p.upvotes <> (
             select count(*) from post_votes v
             where v.post_id = p.id and v.value = 1
           )
           or p.downvotes <> (
             select count(*) from post_votes v
             where v.post_id = p.id and v.value = -1
           )
      `);
      assertEquals(Number(mismatched.rows[0].n), 0);

      // ---- hot ordering is stable and monotonic -----------------------
      const hotA = await getHotFeed(db, 100);
      const hotB = await getHotFeed(db, 100);
      assertEquals(
        hotA.posts.map((p) => p.id),
        hotB.posts.map((p) => p.id),
      );
      assertNonIncreasing(hotA.posts);

      // ---- keyset pagination produces no duplicates -------------------
      const hotPaged = await collect<HotCursor>(
        (cursor) => getHotFeed(db, 5, cursor),
      );
      assertEquals(new Set(hotPaged).size, hotPaged.length); // no dupes
      assertEquals(hotPaged, hotA.posts.map((p) => p.id)); // same order

      const newSingle = await getNewFeed(db, 100);
      const newPaged = await collect<NewCursor>(
        (cursor) => getNewFeed(db, 5, cursor),
      );
      assertEquals(new Set(newPaged).size, newPaged.length);
      assertEquals(newPaged, newSingle.posts.map((p) => p.id));
    } finally {
      await db.close();
    }
  },
});
