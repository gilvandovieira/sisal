/**
 * Network-free unit tests: the rising-score model and the feed SQL.
 *
 * These run with only `--allow-read` and never touch a database. The
 * database-backed behavior is covered by the gated suite in feed_db_test.ts.
 *
 * @module
 */

import { assertAlmostEquals, assertEquals } from "@std/assert";
import { createDatabase } from "@sisal/orm";

import {
  ACTIVITY_WEIGHTS,
  bucket5mIso,
  bucketActivityScore,
  calculateRisingScore,
  type ScoredBucket,
} from "./src/rising.ts";
import { getNewFeed, getRisingFeed } from "./src/queries.ts";
import type { LibsqlDatabase } from "./src/db.ts";

const NOW = new Date("2026-06-28T12:00:00.000Z");

function bucketAt(minutesAgo: number, activityScore: number): ScoredBucket {
  return {
    bucketStart: bucket5mIso(new Date(NOW.getTime() - minutesAgo * 60_000)),
    activityScore,
  };
}

Deno.test("bucket5mIso floors to the 5-minute bucket as an ISO string", () => {
  assertEquals(
    bucket5mIso(new Date("2026-06-28T12:04:59Z")),
    "2026-06-28T12:00:00.000Z",
  );
  assertEquals(
    bucket5mIso(new Date("2026-06-28T12:05:00Z")),
    "2026-06-28T12:05:00.000Z",
  );
  assertEquals(
    bucket5mIso(new Date("2026-06-28T12:14:30Z")),
    "2026-06-28T12:10:00.000Z",
  );
});

Deno.test("bucketActivityScore applies the documented weights", () => {
  assertEquals(
    bucketActivityScore({
      upvotes: 1,
      downvotes: 0,
      comments: 0,
      uniqueActors: 0,
      reports: 0,
    }),
    ACTIVITY_WEIGHTS.upvote,
  );
  const oneComment = bucketActivityScore({
    upvotes: 0,
    downvotes: 0,
    comments: 1,
    uniqueActors: 0,
    reports: 0,
  });
  const threeUpvotes = bucketActivityScore({
    upvotes: 3,
    downvotes: 0,
    comments: 0,
    uniqueActors: 0,
    reports: 0,
  });
  assertEquals(oneComment, threeUpvotes); // a comment is worth three upvotes
});

Deno.test("diverse actors beat repeat activity from one actor", () => {
  const diverse = bucketActivityScore({
    upvotes: 10,
    downvotes: 0,
    comments: 0,
    uniqueActors: 10,
    reports: 0,
  });
  const spammy = bucketActivityScore({
    upvotes: 10,
    downvotes: 0,
    comments: 0,
    uniqueActors: 1,
    reports: 0,
  });
  assertEquals([diverse, spammy], [30, 12]);
  if (!(diverse > spammy)) {
    throw new Error("unique actors should outrank repeat activity");
  }
});

Deno.test("calculateRisingScore weights recent activity most", () => {
  // Fresh: last_15m=last_60m=10, accel=10 → 10*3+10+10*2 = 60.
  assertAlmostEquals(calculateRisingScore([bucketAt(2, 10)], NOW), 60);
  // 90m ago: only prev_60m sees it → the score-driving windows are all 0.
  assertAlmostEquals(calculateRisingScore([bucketAt(90, 10)], NOW), 0);
});

Deno.test("calculateRisingScore is time-dependent (windows slide)", () => {
  const buckets = [bucketAt(2, 12)];
  const atNow = calculateRisingScore(buckets, NOW);
  const later = new Date(NOW.getTime() + 30 * 60_000);
  const atLater = calculateRisingScore(buckets, later);
  if (!(atNow > atLater)) throw new Error("expected score to decay over time");
  assertAlmostEquals(atLater, 12); // only last_60m remains 30m later
});

Deno.test("calculateRisingScore ignores future and out-of-window buckets", () => {
  const inWindow = bucketAt(2, 5);
  // bucketAt with a negative argument lands AFTER `now` (a future bucket).
  const future = bucketAt(-10, 100);
  // Older than the 120-minute floor.
  const old = bucketAt(200, 100);

  const onlyInWindow = calculateRisingScore([inWindow], NOW);
  const withNoise = calculateRisingScore([inWindow, future, old], NOW);
  // The future and old buckets contribute nothing despite their large scores.
  assertEquals(withNoise, onlyInWindow);
  // Deterministic: same inputs + same `now` ⇒ same score.
  assertEquals(calculateRisingScore([inWindow, future, old], NOW), withNoise);
});

Deno.test("feeds build and render without a database (sqlite noop)", async () => {
  const db = createDatabase({ dialect: "sqlite" }) as unknown as LibsqlDatabase;

  const newFeed = await getNewFeed(db, 10);
  assertEquals(newFeed.posts, []);
  assertEquals(newFeed.nextCursor, undefined);

  const rising = await getRisingFeed(db, 10, {
    rising_score: 42,
    rising_score_updated_at: "2026-06-28T12:00:00.000Z",
    id: "00000000-0000-0000-0000-000000000000",
  });
  assertEquals(rising.posts, []);
});
