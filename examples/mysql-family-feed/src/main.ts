/**
 * Demo: prove the rising feed end to end against MySQL/MariaDB.
 *
 *   deno task demo
 *   deno task demo -- --reset
 *
 * Everything runs at fixed DEMO_NOW because a rising score is time-dependent.
 *
 * @module
 */

import { openDb } from "./db.ts";
import { runMigrations } from "./migrate.ts";
import { DEMO_NOW, DEMO_TARGET_KEY, seed, type SeededPost } from "./seed.ts";
import { posts } from "./schema.ts";
import { type FeedPost, getNewFeed, getRisingFeed } from "./queries.ts";
import { recordPostActivity } from "./activity.ts";
import {
  recomputeAllRisingScores,
  recomputePostRisingScore,
} from "./recompute.ts";
import { recomputeAllRisingScoresCtes } from "./recompute_ctes.ts";
import { mysqlTimestamp, parseMysqlTimestamp } from "./rising.ts";

function ageLabel(createdAt: string): string {
  const hours =
    (DEMO_NOW.getTime() - parseMysqlTimestamp(createdAt).getTime()) /
    3_600_000;
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

function risingRankOf(rows: readonly FeedPost[], id: string): number {
  return rows.findIndex((post) => post.id === id) + 1;
}

export async function main(): Promise<void> {
  const reset = Deno.args.includes("--reset");
  const db = await openDb();
  try {
    await runMigrations(db, { reset });
    const count = await db.$count(posts);
    let seeded: SeededPost[];
    if (reset || count === 0) {
      seeded = await seed(db, DEMO_NOW);
      console.log(`seeded ${seeded.length} posts at DEMO_NOW.`);
    } else {
      console.log(`database has ${count} posts; reseeding for the demo.`);
      seeded = await seed(db, DEMO_NOW);
    }
    const target = seeded.find((post) => post.key === DEMO_TARGET_KEY);
    if (target === undefined) throw new Error("demo target post not seeded");

    const newFeed = await getNewFeed(db, 10);
    printFeed("NEW feed (created_at desc) - top 10:", newFeed.posts);

    const risingBefore = await getRisingFeed(db, 10);
    printFeed("RISING feed (rising_score desc) - top 10:", risingBefore.posts);

    const rankBefore = risingRankOf(
      (await getRisingFeed(db, 100)).posts,
      target.id,
    );
    console.log(
      `\n"${target.title}" starts at /rising rank ` +
        `#${rankBefore === 0 ? "-" : rankBefore}.`,
    );

    for (let i = 0; i < 12; i += 1) {
      await recordPostActivity(db, {
        postId: target.id,
        actorId: crypto.randomUUID(),
        kind: i % 4 === 0 ? "comment" : "upvote",
        at: DEMO_NOW,
      });
    }
    const newScore = await recomputePostRisingScore(db, target.id, DEMO_NOW);
    console.log(
      `  recorded a fresh burst; recompute -> rising_score=` +
        `${newScore.toFixed(2)}.`,
    );

    const risingAfter = await getRisingFeed(db, 100);
    const rankAfter = risingRankOf(risingAfter.posts, target.id);
    console.log(`  /rising rank: #${rankBefore} -> #${rankAfter}.`);
    printFeed(
      "RISING feed after the burst - top 10:",
      risingAfter.posts.slice(0, 10),
    );

    const later = new Date(DEMO_NOW.getTime() + 70 * 60_000);
    await recomputeAllRisingScoresCtes(db, { now: later });
    const risingLater = await getRisingFeed(db, 10);
    printFeed(
      "RISING feed 70 minutes later (early bursts have decayed):",
      risingLater.posts,
    );
    await recomputeAllRisingScores(db, DEMO_NOW);

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

    console.log(
      `\n✓ MySQL-family rising-feed demo complete at ${
        mysqlTimestamp(DEMO_NOW)
      }.`,
    );
  } finally {
    await db.close();
  }
}

if (import.meta.main) {
  await main();
}
