/**
 * Demo: prove the hot feed end to end against Neon/Postgres.
 *
 *   deno run --env-file=.env --allow-env --allow-net --allow-read src/main.ts
 *   ...                                                        src/main.ts --reset
 *
 * Steps:
 *   1. Connect to Neon (DATABASE_URL for runtime, DATABASE_DIRECT_URL for the
 *      idempotent migration pass).
 *   2. Ensure migrations are applied; seed if the database is empty (or --reset).
 *   3. Print the New feed (created_at desc).
 *   4. Print the Hot feed (hot_score desc).
 *   5. Cast votes through app.vote_post (single-statement atomic mutation).
 *   6. Print the Hot feed again — the ranking has changed.
 *   7. Show keyset pagination producing two non-overlapping hot pages.
 *
 * @module
 */

import { sql } from "@sisal/orm";
import type { NeonDatabase } from "@sisal/neon";
import { openAdminDb, openDb } from "./db.ts";
import { runMigrations } from "./migrate.ts";
import { RISING_POST_TITLE, seed } from "./seed.ts";
import { posts } from "./schema.ts";
import { type FeedPost, getHotFeed, getNewFeed } from "./queries.ts";
import { votePost } from "./vote.ts";

const NOW = Date.now();

function ageLabel(createdAt: Date): string {
  const hours = (NOW - createdAt.getTime()) / 3_600_000;
  return `${hours.toFixed(1)}h ago`.padStart(8);
}

function printFeed(label: string, rows: readonly FeedPost[]): void {
  console.log(`\n${label}`);
  rows.forEach((post, i) => {
    const rank = String(i + 1).padStart(2);
    const score = `${post.score >= 0 ? "+" : ""}${post.score}`.padStart(4);
    console.log(
      `  ${rank}. hot=${post.hot_score.toFixed(3).padStart(8)}  ` +
        `score=${score} (+${post.upvotes}/-${post.downvotes})  ` +
        `${ageLabel(post.created_at)}  ${post.title}`,
    );
  });
}

async function ensureData(reset: boolean): Promise<void> {
  // Migrations/admin work runs over the direct connection. Idempotent DDL means
  // this is safe to run on every demo.
  const admin = await openAdminDb();
  try {
    await runMigrations(admin, { reset });
  } finally {
    await admin.close();
  }

  const db = await openDb();
  try {
    const count = await db.$count(posts);
    if (reset || count === 0) {
      const seeded = await seed(db);
      console.log(`seeded ${seeded.length} posts.\n`);
    } else {
      console.log(`database already has ${count} posts; skipping seed.\n`);
    }
  } finally {
    await db.close();
  }
}

async function findPostIdByTitle(
  db: NeonDatabase,
  title: string,
): Promise<string | undefined> {
  const result = await db.query<{ id: string }>(
    sql`select id from posts where title = ${title} limit 1`,
  );
  return result.rows[0]?.id;
}

async function hotRankOf(db: NeonDatabase, id: string): Promise<number> {
  const { posts } = await getHotFeed(db, 100);
  return posts.findIndex((post) => post.id === id) + 1;
}

async function main(): Promise<void> {
  const reset = Deno.args.includes("--reset");
  await ensureData(reset);

  const db = await openDb();
  try {
    // ---- 3 + 4. The two timelines -------------------------------------
    const newFeed = await getNewFeed(db, 10);
    printFeed("NEW feed (created_at desc) — top 10:", newFeed.posts);

    const hotFeed = await getHotFeed(db, 10);
    printFeed("HOT feed (hot_score desc) — top 10:", hotFeed.posts);

    // ---- 5. Atomic mutation via app.vote_post -------------------------
    const risingId = await findPostIdByTitle(db, RISING_POST_TITLE);
    if (risingId === undefined) {
      throw new Error(`could not find seeded post "${RISING_POST_TITLE}"`);
    }

    const rankBefore = await hotRankOf(db, risingId);
    console.log(
      `\nVoting on "${RISING_POST_TITLE}" (hot rank #${rankBefore} before).`,
    );

    // One representative single-statement call; print the atomic result.
    const first = await votePost(db, risingId, crypto.randomUUID(), 1);
    console.log(
      `  app.vote_post -> score=${first.score} ` +
        `upvotes=${first.upvotes} downvotes=${first.downvotes} ` +
        `hot_score=${first.hot_score.toFixed(3)}`,
    );

    // A handful more distinct voters so the climb is visible.
    for (let i = 0; i < 14; i += 1) {
      await votePost(db, risingId, crypto.randomUUID(), 1);
    }

    const rankAfter = await hotRankOf(db, risingId);
    console.log(
      `  hot rank: #${rankBefore} -> #${rankAfter} after 15 upvotes.`,
    );

    // ---- 6. Hot feed reflects the new ranking -------------------------
    const hotAfter = await getHotFeed(db, 10);
    printFeed("HOT feed after voting — top 10:", hotAfter.posts);

    // ---- 7. Keyset pagination: two non-overlapping pages --------------
    const pageSize = 5;
    const page1 = await getHotFeed(db, pageSize);
    const page2 = page1.nextCursor === undefined
      ? { posts: [] as FeedPost[] }
      : await getHotFeed(db, pageSize, page1.nextCursor);

    const page1Ids = new Set(page1.posts.map((post) => post.id));
    const overlap = page2.posts.filter((post) => page1Ids.has(post.id));
    printFeed("HOT page 1:", page1.posts);
    printFeed("HOT page 2 (via cursor):", page2.posts);
    console.log(
      `\nCursor pagination overlap between pages: ${overlap.length} ` +
        `(expected 0).`,
    );

    console.log("\n✓ Neon hot-feed demo complete.");
  } finally {
    await db.close();
  }
}

export { main };

if (import.meta.main) {
  await main();
}
