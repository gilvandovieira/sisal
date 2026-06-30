/**
 * Network-free unit tests for the activity-vector model.
 *
 * Runs with only `--allow-read`; vector projection and similarity are pure
 * functions. The database-backed chain (events → buckets → window MAs → stats →
 * vector → similarity → retention) is covered by the gated feature_db_test.ts.
 *
 * @module
 */

import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertThrows,
} from "@std/assert";
import {
  type ActivityStatsFeatures,
  buildActivityVector,
  cosineSimilarity,
  l2Distance,
  VECTOR_DIMENSIONS,
  VECTOR_LENGTH,
} from "./src/vector.ts";

const ZERO: ActivityStatsFeatures = {
  votes_1h: 0,
  comments_1h: 0,
  reports_1h: 0,
  unique_actors_1h: 0,
  vote_ma_6h: 0,
  comment_ma_6h: 0,
  hot_score: 0,
  rising_score: 0,
  age_minutes: 0,
};

function feat(patch: Partial<ActivityStatsFeatures>): ActivityStatsFeatures {
  return { ...ZERO, ...patch };
}

Deno.test("buildActivityVector projects the documented dimension order", () => {
  const v = buildActivityVector({
    votes_1h: 1,
    comments_1h: 2,
    reports_1h: 3,
    unique_actors_1h: 4,
    vote_ma_6h: 5,
    comment_ma_6h: 6,
    hot_score: 7,
    rising_score: 8,
    age_minutes: 9,
  });
  assertEquals(v, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assertEquals(v.length, VECTOR_LENGTH);
  assertEquals(VECTOR_DIMENSIONS.length, VECTOR_LENGTH);
  assertEquals(VECTOR_DIMENSIONS[4], "vote_ma_6h");
});

Deno.test("cosineSimilarity returns 1 for identical non-zero vectors", () => {
  const a = buildActivityVector(
    feat({ votes_1h: 40, comment_ma_6h: 5, hot_score: 12 }),
  );
  assertAlmostEquals(cosineSimilarity(a, a), 1);
});

Deno.test("cosineSimilarity returns 0 when either vector is all zeros", () => {
  const zero = buildActivityVector(ZERO);
  const nonZero = buildActivityVector(feat({ votes_1h: 10 }));
  assertEquals(cosineSimilarity(zero, nonZero), 0);
  assertEquals(cosineSimilarity(nonZero, zero), 0);
  assertEquals(cosineSimilarity(zero, zero), 0);
});

Deno.test("cosineSimilarity throws on a dimension mismatch", () => {
  assertThrows(
    () => cosineSimilarity([1, 2, 3], [1, 2]),
    Error,
    "length mismatch",
  );
});

Deno.test("l2Distance returns 0 for identical vectors and >0 otherwise", () => {
  const a = buildActivityVector(feat({ votes_1h: 30, hot_score: 9 }));
  assertEquals(l2Distance(a, a), 0);
  const b = buildActivityVector(feat({ votes_1h: 30, hot_score: 50 }));
  assert(l2Distance(a, b) > 0);
});

Deno.test("similar behavior vectors score higher than unrelated ones", () => {
  // Two vote-heavy posts (close), one report-heavy post (different shape).
  const voteA = buildActivityVector(feat({
    votes_1h: 40,
    comments_1h: 1,
    unique_actors_1h: 30,
    vote_ma_6h: 30,
    hot_score: 16,
    rising_score: 18,
    age_minutes: 200,
  }));
  const voteB = buildActivityVector(feat({
    votes_1h: 46,
    comments_1h: 1,
    unique_actors_1h: 34,
    vote_ma_6h: 34,
    hot_score: 16,
    rising_score: 18,
    age_minutes: 210,
  }));
  const report = buildActivityVector(feat({
    votes_1h: 6,
    comments_1h: 2,
    reports_1h: 10,
    unique_actors_1h: 6,
    vote_ma_6h: 5,
    hot_score: 4,
    rising_score: 2,
    age_minutes: 240,
  }));

  const sameBehavior = cosineSimilarity(voteA, voteB);
  const unrelated = cosineSimilarity(voteA, report);
  assert(
    sameBehavior > unrelated,
    `same-behavior cosine (${sameBehavior}) should exceed unrelated (${unrelated})`,
  );
});
