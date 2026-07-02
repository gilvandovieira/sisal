/**
 * Network-free unit tests: the rising-score model and feed SQL rendering.
 *
 * Database-backed behavior is covered by the gated suite in feed_db_test.ts.
 *
 * @module
 */

import { assertAlmostEquals, assertEquals } from "@std/assert";
import { createDatabase } from "@sisal/orm";

import {
  ACTIVITY_WEIGHTS,
  bucket5mMysql,
  bucketActivityScore,
  calculateRisingScore,
  mysqlTimestamp,
  parseMysqlTimestamp,
  type ScoredBucket,
} from "./src/rising.ts";
import { getNewFeed, getRisingFeed } from "./src/queries.ts";
import type { MysqlDatabase } from "./src/db.ts";

const NOW = new Date("2026-06-28T12:00:00.000Z");

function bucketAt(minutesAgo: number, activityScore: number): ScoredBucket {
  return {
    bucketStart: bucket5mMysql(new Date(NOW.getTime() - minutesAgo * 60_000)),
    activityScore,
  };
}

Deno.test("mysqlTimestamp formats and parses UTC DATETIME(6) literals", () => {
  const formatted = mysqlTimestamp(new Date("2026-06-28T12:04:59.123Z"));
  assertEquals(formatted, "2026-06-28 12:04:59.123000");
  assertEquals(
    parseMysqlTimestamp(formatted).toISOString(),
    "2026-06-28T12:04:59.123Z",
  );
});

Deno.test("bucket5mMysql floors to the 5-minute bucket", () => {
  assertEquals(
    bucket5mMysql(new Date("2026-06-28T12:04:59Z")),
    "2026-06-28 12:00:00.000000",
  );
  assertEquals(
    bucket5mMysql(new Date("2026-06-28T12:05:00Z")),
    "2026-06-28 12:05:00.000000",
  );
  assertEquals(
    bucket5mMysql(new Date("2026-06-28T12:14:30Z")),
    "2026-06-28 12:10:00.000000",
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
  assertEquals(oneComment, threeUpvotes);
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
  assertAlmostEquals(calculateRisingScore([bucketAt(2, 10)], NOW), 60);
  assertAlmostEquals(calculateRisingScore([bucketAt(90, 10)], NOW), 0);
});

Deno.test("calculateRisingScore is time-dependent", () => {
  const buckets = [bucketAt(2, 12)];
  const atNow = calculateRisingScore(buckets, NOW);
  const later = new Date(NOW.getTime() + 30 * 60_000);
  const atLater = calculateRisingScore(buckets, later);
  if (!(atNow > atLater)) throw new Error("expected score to decay over time");
  assertAlmostEquals(atLater, 12);
});

Deno.test("calculateRisingScore ignores future and out-of-window buckets", () => {
  const inWindow = bucketAt(2, 5);
  const future = bucketAt(-10, 100);
  const old = bucketAt(200, 100);

  const onlyInWindow = calculateRisingScore([inWindow], NOW);
  const withNoise = calculateRisingScore([inWindow, future, old], NOW);
  assertEquals(withNoise, onlyInWindow);
});

Deno.test("feeds build and render without a database (mysql noop)", async () => {
  const db = createDatabase({ dialect: "mysql" }) as unknown as MysqlDatabase;

  const newFeed = await getNewFeed(db, 10);
  assertEquals(newFeed.posts, []);
  assertEquals(newFeed.nextCursor, undefined);

  const rising = await getRisingFeed(db, 10, {
    rising_score: 42,
    rising_score_updated_at: "2026-06-28 12:00:00.000000",
    id: "00000000-0000-0000-0000-000000000000",
  });
  assertEquals(rising.posts, []);
});
