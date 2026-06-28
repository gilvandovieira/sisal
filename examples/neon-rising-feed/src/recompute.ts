/**
 * Recomputing stored rising scores.
 *
 * Because the rising score is TIME-DEPENDENT, the stored value goes stale as
 * the clock moves; it must be recomputed periodically (or right after recording
 * activity). This example needs no background worker: it exposes explicit
 * recompute entry points you can run from `deno task recompute`, a cron, or the
 * demo.
 *
 * Both wrappers call PostgreSQL functions through the typed `db.call(...)`
 * surface (no raw `sql` string). `p_now` is passed explicitly so the recompute
 * is deterministic — the same data + the same `now` always yields the same
 * scores.
 *
 * @module
 */

import { columns, defineFunction } from "@sisal/orm";
import type { NeonDatabase } from "@sisal/neon";
import { type TimeInput, toInstant } from "./rising.ts";

/** `app.recompute_all_rising_scores(now) RETURNS integer` (rows updated). */
const recomputeAllFn = defineFunction("app.recompute_all_rising_scores", {
  args: { now: columns.timestamp({ withTimezone: true }) },
  returns: columns.integer().notNull(),
});

/** `app.recompute_post_rising_score(post, now) RETURNS TABLE (...)`. */
const recomputePostFn = defineFunction("app.recompute_post_rising_score", {
  args: {
    postId: columns.uuid(),
    now: columns.timestamp({ withTimezone: true }),
  },
  returns: {
    id: columns.uuid().notNull(),
    rising_score: columns.doublePrecision().notNull(),
    rising_score_updated_at: columns.timestamp({ withTimezone: true })
      .notNull(),
  },
});

/** The updated post row returned by a single recompute. */
export interface RecomputedPost {
  readonly id: string;
  readonly rising_score: number;
  readonly rising_score_updated_at: Temporal.Instant;
}

/** Recomputes and stores the rising score for every published post at `now`. */
export function recomputeAllRisingScores(
  db: NeonDatabase,
  now: TimeInput,
): Promise<number> {
  return db.call(recomputeAllFn, { now: toInstant(now) }).one();
}

/** Recomputes and stores one post's rising score at `now`. */
export function recomputePostRisingScore(
  db: NeonDatabase,
  postId: string,
  now: TimeInput,
): Promise<RecomputedPost> {
  return db.call(recomputePostFn, { postId, now: toInstant(now) }).one();
}

async function main(): Promise<void> {
  const { openDb } = await import("./db.ts");
  const db = await openDb();
  try {
    // No --now flag is wired by default: recomputing at the real wall clock is
    // the production behavior. The demo and tests pass an explicit `now`.
    const now = Temporal.Now.instant();
    const updated = await recomputeAllRisingScores(db, now);
    console.log(
      `recomputed rising_score for ${updated} post(s) at ${now.toString()}.`,
    );
  } finally {
    await db.close();
  }
}

if (import.meta.main) {
  await main();
}
