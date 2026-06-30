/**
 * Database-backed integration test for the activity-vectors example.
 *
 * Gated: runs only when `SISAL_NEON_ACTIVITY_VECTORS_IT=1` and `DATABASE_URL`
 * are set (mirrors the repo's `integration/` convention). It RESETS and reseeds
 * the target database, so point it at a scratch Neon branch (or local Postgres).
 *
 *   SISAL_NEON_ACTIVITY_VECTORS_IT=1 \
 *     DATABASE_URL="postgres://user:pw@ep-xxx.neon.tech/db?sslmode=require" \
 *     deno test -A feature_db_test.ts
 *
 * Covers the whole chain: migrations + SQL functions, deterministic seed,
 * events→buckets fold, the window-function stats computation (exact values for
 * known data), the SQL ↔ TS vector projection, similarity, retention rollups +
 * event pruning (stats survive), and DEMO_NOW determinism.
 *
 * @module
 */

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { connect, type NeonDatabase } from "@sisal/neon";

import { runMigrations } from "./src/migrate.ts";
import { DEMO_NOW, representativePostId, seed } from "./src/seed.ts";
import { foldEventsToBuckets } from "./src/events.ts";
import {
  computeStats,
  getActivityVectorSql,
  getStats,
  statsToVector,
} from "./src/stats.ts";
import { getSimilarPosts, getSimilarPostsSql } from "./src/queries.ts";
import { pruneEvents, rollupDaily, rollupMonthly } from "./src/retention.ts";
import { VECTOR_LENGTH } from "./src/vector.ts";

function env(key: string): string | undefined {
  try {
    return Deno.env.get(key);
  } catch {
    return undefined;
  }
}

const URL = env("DATABASE_URL");
const SKIP = env("SISAL_NEON_ACTIVITY_VECTORS_IT") !== "1" || URL === undefined;

const HOUR = 3600_000;
const FROM = new Date(DEMO_NOW.getTime() - 24 * HOUR);
const UNTIL = new Date(DEMO_NOW.getTime() + HOUR);

Deno.test({
  name:
    "neon activity vectors: events -> buckets -> stats -> vector -> retention",
  ignore: SKIP,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db: NeonDatabase = await connect({ url: URL! });
    try {
      // ---- 1 + 2. migrations + deterministic seed (posts + raw events) ----
      await runMigrations(db, { reset: true });
      const seeded = await seed(db);
      assertEquals(seeded.length, 24);
      const categoryOf = new Map(seeded.map((p) => [p.id, p.category]));

      // ---- 3. fold raw events into hourly buckets ----------------------
      const buckets = await foldEventsToBuckets(db, FROM, UNTIL);
      assert(buckets > 0, "fold should produce buckets");

      // ---- 4 + 5. compute stats; exact values for the fast-spike rep ---
      const computed = await computeStats(db, DEMO_NOW);
      assertEquals(computed, 24);

      const fastSpike = representativePostId("fast_spike");
      const s = await getStats(db, fastSpike);
      assert(s !== undefined);
      // fast_spike (scale 1.0): the 5h-ago hour is empty, so 5 hourly buckets
      // exist with votes 1,2,4,9,40 and comments 0,1,1,3,12.
      assertEquals(Number(s.votes_1h), 40); // current hour
      assertEquals(Number(s.comments_1h), 12);
      assertEquals(Number(s.reports_1h), 0);
      assertEquals(Number(s.unique_actors_1h), 28);
      assertAlmostEquals(Number(s.vote_ma_6h), 56 / 5, 1e-9); // 11.2
      assertAlmostEquals(Number(s.comment_ma_6h), 17 / 5, 1e-9); // 3.4
      assertEquals(Number(s.hot_score), 20);
      assertEquals(Number(s.rising_score), 80);
      assertAlmostEquals(Number(s.age_minutes), 300, 1e-6);

      // ---- 6 + 7. vector length + SQL projection matches TS ------------
      const tsVector = statsToVector(s);
      assertEquals(tsVector.length, VECTOR_LENGTH);
      const sqlVector = await getActivityVectorSql(db, fastSpike);
      assertEquals(sqlVector.length, VECTOR_LENGTH);
      for (let i = 0; i < VECTOR_LENGTH; i += 1) {
        assertAlmostEquals(sqlVector[i], tsVector[i], 1e-9);
      }

      // ---- 8. similarity: source excluded, same category nearest ------
      for (const category of ["fast_spike", "comment_heavy", "report_heavy"]) {
        const source = representativePostId(category);
        const similar = await getSimilarPosts(db, source, 5);
        assert(similar.length > 0);
        assert(
          similar.every((x) => x.id !== source),
          "similarity must exclude the source post",
        );
        assertEquals(
          categoryOf.get(similar[0].id),
          category,
          `${category} nearest neighbor should be its own category`,
        );
      }
      // The SQL cosine path agrees on the nearest category.
      const sqlSimilar = await getSimilarPostsSql(db, fastSpike, 5);
      assertEquals(categoryOf.get(sqlSimilar[0].id), "fast_spike");

      // ---- 9. retention: roll up, prune raw events, stats survive -----
      const daily = await rollupDaily(db, FROM, UNTIL);
      const monthly = await rollupMonthly(db, FROM, UNTIL);
      // 21 posts have buckets; the 3 'dead' posts have no events → no rollup.
      assertEquals(daily, 21); // all activity in one day
      assertEquals(monthly, 21); // one month
      const cutoff = new Date(DEMO_NOW.getTime() - 3 * HOUR);
      const pruned = await pruneEvents(db, cutoff);
      assert(pruned > 0, "old events should be pruned");
      // Stats computed earlier are untouched by pruning raw events.
      const afterPrune = await getStats(db, fastSpike);
      assertEquals(statsToVector(afterPrune!), tsVector);

      // ---- 10. DEMO_NOW determinism ------------------------------------
      await computeStats(db, DEMO_NOW);
      const recomputed = await getStats(db, fastSpike);
      assertEquals(statsToVector(recomputed!), tsVector);
    } finally {
      await db.close();
    }
  },
});
