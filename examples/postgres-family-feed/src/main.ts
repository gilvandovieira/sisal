/**
 * Demo: prove the rising feed end to end against a normal PostgreSQL 18.
 *
 *   docker compose up -d
 *   deno run --env-file=.env --allow-env --allow-net --allow-read src/main.ts
 *   ...                                                        src/main.ts --reset
 *
 * Everything runs at a fixed DEMO_NOW (never the wall clock), because a rising
 * score is time-dependent: if we recomputed at the real `now`, all the seeded
 * activity would be hours old and every score would collapse to zero. Passing
 * an explicit `now` is the whole point.
 *
 * Steps:
 *   1. Connect, migrate (idempotent), seed at DEMO_NOW.
 *   2. Print /new (created_at desc) and /rising (rising_score desc).
 *   3. Record fresh activity on a low-ranked post, recompute it at DEMO_NOW.
 *   4. Print /rising again — the boosted post has climbed.
 *   5. Advance the clock and recompute: the early burst decays out of the
 *      15-minute window, showing the score is time-dependent.
 *   6. Show keyset pagination producing two non-overlapping /rising pages.
 *
 * @module
 */

import { openAdminDb, openDb } from "./db.ts";
import { runMigrations } from "./migrate.ts";
import { DEMO_NOW, DEMO_TARGET_KEY, seed, type SeededPost } from "./seed.ts";
import { posts } from "./schema.ts";
import { type FeedPost, getNewFeed, getRisingFeed } from "./queries.ts";
import { recordPostActivity } from "./activity.ts";
import {
  recomputeAllRisingScores,
  recomputePostRisingScore,
} from "./recompute.ts";

function ageLabel(createdAt: Date): string {
  const hours = (DEMO_NOW.getTime() - createdAt.getTime()) / 3_600_000;
  return `${hours.toFixed(1)}h`.padStart(6);
}

function printFeed(label: string, rows: readonly FeedPost[]): void {
  console.log(`\n${label}`);
  if (rows.length === 0) {
    console.log("  (empty)");
    return;
  }
  rows.forEach((post, i) => {
    const rank = String(i + 1).padStart(2);
    console.log(
      `  ${rank}. rising=${post.rising_score.toFixed(2).padStart(8)}  ` +
        `age=${ageLabel(post.created_at)}  ${post.title}`,
    );
  });
}

async function ensureData(reset: boolean): Promise<SeededPost[]> {
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
      const seeded = await seed(db, DEMO_NOW);
      console.log(`seeded ${seeded.length} posts at DEMO_NOW.\n`);
      return seeded;
    }
    console.log(
      `database already has ${count} posts; reseeding for the demo.\n`,
    );
    return await seed(db, DEMO_NOW);
  } finally {
    await db.close();
  }
}

function risingRankOf(rows: readonly FeedPost[], id: string): number {
  return rows.findIndex((post) => post.id === id) + 1;
}

async function main(): Promise<void> {
  const reset = Deno.args.includes("--reset");
  const seeded = await ensureData(reset);
  const target = seeded.find((post) => post.key === DEMO_TARGET_KEY);
  if (target === undefined) throw new Error("demo target post not seeded");

  const db = await openDb();
  try {
    // ---- 2. The two timelines ----------------------------------------
    const newFeed = await getNewFeed(db, 10);
    printFeed("NEW feed (created_at desc) — top 10:", newFeed.posts);

    const risingBefore = await getRisingFeed(db, 10);
    printFeed("RISING feed (rising_score desc) — top 10:", risingBefore.posts);

    const rankBefore = risingRankOf(
      (await getRisingFeed(db, 100)).posts,
      target.id,
    );
    console.log(
      `\n"${target.title}" starts at /rising rank ` +
        `#${rankBefore === 0 ? "—" : rankBefore}.`,
    );

    // ---- 3. Record fresh activity on the target, then recompute it ----
    // A burst of distinct upvoters + comments, all dated at DEMO_NOW.
    for (let i = 0; i < 12; i += 1) {
      await recordPostActivity(db, {
        postId: target.id,
        actorId: crypto.randomUUID(),
        kind: i % 4 === 0 ? "comment" : "upvote",
        at: DEMO_NOW,
      });
    }
    const recomputed = await recomputePostRisingScore(db, target.id, DEMO_NOW);
    console.log(
      `  recorded a fresh burst; recompute → rising_score=` +
        `${recomputed.rising_score.toFixed(2)}.`,
    );

    // ---- 4. /rising reflects the climb -------------------------------
    const risingAfter = await getRisingFeed(db, 100);
    const rankAfter = risingRankOf(risingAfter.posts, target.id);
    console.log(`  /rising rank: #${rankBefore} → #${rankAfter}.`);
    printFeed(
      "RISING feed after the burst — top 10:",
      risingAfter.posts.slice(0, 10),
    );

    // ---- 5. Time-dependence: advance the clock, recompute all --------
    const later = new Date(DEMO_NOW.getTime() + 70 * 60_000); // +70 minutes
    await recomputeAllRisingScores(db, later);
    const risingLater = await getRisingFeed(db, 10);
    printFeed(
      "RISING feed 70 minutes later (early bursts have decayed):",
      risingLater.posts,
    );
    // Restore DEMO_NOW scores so re-running the demo is stable.
    await recomputeAllRisingScores(db, DEMO_NOW);

    // ---- 6. Keyset pagination: two non-overlapping pages -------------
    const pageSize = 5;
    const page1 = await getRisingFeed(db, pageSize);
    const page2 = page1.nextCursor === undefined
      ? { posts: [] as FeedPost[] }
      : await getRisingFeed(db, pageSize, page1.nextCursor);
    const page1Ids = new Set(page1.posts.map((post) => post.id));
    const overlap = page2.posts.filter((post) => page1Ids.has(post.id));
    printFeed("RISING page 1:", page1.posts);
    printFeed("RISING page 2 (via cursor):", page2.posts);
    console.log(
      `\nCursor pagination overlap between pages: ${overlap.length} ` +
        `(expected 0).`,
    );

    console.log("\n✓ PostgreSQL rising-feed demo complete.");
  } finally {
    await db.close();
  }
}

export { main };

if (import.meta.main) {
  await main();
}
