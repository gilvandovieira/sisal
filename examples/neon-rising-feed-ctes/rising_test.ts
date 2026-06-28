/**
 * Network-free unit tests: the rising-score model and the feed SQL.
 *
 * These run with only `--allow-read` and never touch a database. The
 * database-backed behavior (the recording CTE, dedup, weight ordering,
 * recompute CTEs, feed ordering, pagination, window decay) is covered by the
 * gated suite in feed_db_test.ts.
 *
 * @module
 */

import { assertAlmostEquals, assertEquals } from "@std/assert";
import { createDatabase } from "@sisal/orm";

import {
  ACTIVITY_WEIGHTS,
  bucket5m,
  bucketActivityScore,
  calculateRisingScoreTs,
  type ScoredBucket,
} from "./src/rising.ts";
import { getNewFeed, getRisingFeed } from "./src/queries.ts";
import type { NeonDatabase } from "./src/db.ts";

const NOW = new Date("2026-06-28T12:00:00.000Z");

function minutesAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 60_000);
}

Deno.test("bucket5m floors to the start of the 5-minute bucket", () => {
  assertEquals(
    bucket5m(new Date("2026-06-28T12:00:00Z")).toISOString(),
    "2026-06-28T12:00:00.000Z",
  );
  assertEquals(
    bucket5m(new Date("2026-06-28T12:04:59Z")).toISOString(),
    "2026-06-28T12:00:00.000Z",
  );
  assertEquals(
    bucket5m(new Date("2026-06-28T12:05:00Z")).toISOString(),
    "2026-06-28T12:05:00.000Z",
  );
  assertEquals(
    bucket5m(new Date("2026-06-28T12:37:59Z")).toISOString(),
    "2026-06-28T12:35:00.000Z",
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
  // A comment (3) is worth three upvotes (1 each).
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
  assertEquals(oneComment, threeUpvotes);
  // One report (-8) sinks a lot of upvotes.
  const reported = bucketActivityScore({
    upvotes: 5,
    downvotes: 0,
    comments: 0,
    uniqueActors: 5,
    reports: 1,
  });
  assertEquals(reported, 5 * 1 + 5 * 2 - 8); // 7
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
  if (!(diverse > spammy)) {
    throw new Error("unique actors should outrank repeat activity");
  }
  assertEquals(diverse, 30);
  assertEquals(spammy, 12);
});

Deno.test("calculateRisingScoreTs weights recent activity most", () => {
  const fresh: ScoredBucket[] = [
    { bucketStart: bucket5m(minutesAgo(2)), activityScore: 10 },
  ];
  const old: ScoredBucket[] = [
    { bucketStart: bucket5m(minutesAgo(90)), activityScore: 10 },
  ];
  // Fresh: last_15m=last_60m=10, accel=max(10-0,0)=10 → 10*3+10+10*2 = 60.
  assertAlmostEquals(calculateRisingScoreTs(fresh, NOW), 60);
  // 90m ago: only prev_60m sees it → all windows that drive the score are 0.
  assertAlmostEquals(calculateRisingScoreTs(old, NOW), 0);
});

Deno.test("calculateRisingScoreTs is time-dependent (windows slide)", () => {
  const buckets: ScoredBucket[] = [
    { bucketStart: bucket5m(minutesAgo(2)), activityScore: 12 },
  ];
  const atNow = calculateRisingScoreTs(buckets, NOW);
  // 30 minutes later the same bucket is ~32m old: out of last_15m, still in
  // last_60m, so the score drops sharply but is not zero.
  const later = new Date(NOW.getTime() + 30 * 60_000);
  const atLater = calculateRisingScoreTs(buckets, later);
  if (!(atNow > atLater)) throw new Error("expected score to decay over time");
  assertAlmostEquals(atLater, 12); // only last_60m remains
});

Deno.test("calculateRisingScoreTs ignores future and out-of-window buckets", () => {
  const inWindow: ScoredBucket = {
    bucketStart: bucket5m(minutesAgo(2)),
    activityScore: 5,
  };
  // A bucket dated AFTER `now` (clock skew / earlier p_now).
  const future: ScoredBucket = {
    bucketStart: bucket5m(new Date(NOW.getTime() + 10 * 60_000)),
    activityScore: 100,
  };
  // A bucket older than the 120-minute floor.
  const old: ScoredBucket = {
    bucketStart: bucket5m(minutesAgo(200)),
    activityScore: 100,
  };

  const onlyInWindow = calculateRisingScoreTs([inWindow], NOW);
  const withNoise = calculateRisingScoreTs([inWindow, future, old], NOW);
  assertEquals(withNoise, onlyInWindow); // future + old contribute nothing
  assertEquals(calculateRisingScoreTs([inWindow, future, old], NOW), withNoise);
});

Deno.test("feeds build and render without a database (postgres noop)", async () => {
  const db = createDatabase({ dialect: "postgres" }) as unknown as NeonDatabase;

  const newFeed = await getNewFeed(db, 10);
  assertEquals(newFeed.posts, []);
  assertEquals(newFeed.nextCursor, undefined);

  const rising = await getRisingFeed(db, 10, {
    rising_score: 42,
    rising_score_updated_at: new Date("2026-06-28T12:00:00Z"),
    id: "00000000-0000-0000-0000-000000000000",
  });
  assertEquals(rising.posts, []);
});
