/**
 * Builder-native MySQL recompute strategy: chained SELECT CTEs feeding
 * `UPDATE ... FROM` (rendered as MySQL's multi-table update).
 *
 * MySQL proper cannot `UPDATE ... RETURNING`, and MariaDB's `RETURNING` support
 * is per-statement/versioned, so this module writes first and fetches after.
 * That intentional awkwardness is one of the v0.8 roadmap findings.
 *
 * @module
 */

import { and, dateSub, eq, filter, gte, lt, lte, sql, sum } from "@sisal/orm";
import type { MysqlDatabase } from "@sisal/mysql";
import { postActivityBuckets, posts } from "./schema.ts";
import { mysqlTimestamp } from "./rising.ts";

/** The updated post row plus the score-window parts. */
export interface RecomputedPostCtes {
  readonly id: string;
  readonly rising_score: number;
  readonly rising_score_updated_at: string;
  readonly last_15m_score: number;
  readonly last_60m_score: number;
  readonly previous_60m_score: number;
  readonly acceleration_bonus: number;
}

/** Recomputes one post's rising score through chained CTEs. */
export async function recomputePostRisingScoreCtes(
  db: MysqlDatabase,
  args: { readonly postId: string; readonly now: Date },
): Promise<RecomputedPostCtes> {
  const nowLiteral = mysqlTimestamp(args.now);
  const computed = await readComputedScores(db, {
    nowLiteral,
    postId: args.postId,
  });
  const row = computed[0];
  if (row === undefined) {
    throw new Error(
      `recomputePostRisingScoreCtes: post ${args.postId} not found`,
    );
  }

  await writeComputedScores(db, { nowLiteral, postId: args.postId });
  return {
    ...row,
    rising_score: Number(row.rising_score),
    last_15m_score: Number(row.last_15m_score),
    last_60m_score: Number(row.last_60m_score),
    previous_60m_score: Number(row.previous_60m_score),
    acceleration_bonus: Number(row.acceleration_bonus),
  };
}

/** Recomputes every published post through chained CTEs. */
export async function recomputeAllRisingScoresCtes(
  db: MysqlDatabase,
  args: { readonly now: Date },
): Promise<number> {
  const ids = await db.select({ id: posts.columns.id }).from(posts)
    .where(eq(posts.columns.status, "published"))
    .execute();
  if (ids.length === 0) return 0;

  await writeComputedScores(db, { nowLiteral: mysqlTimestamp(args.now) });
  return ids.length;
}

function scoreWindowsCte(
  db: MysqlDatabase,
  options: { readonly nowLiteral: string; readonly postId?: string },
) {
  const b = postActivityBuckets.columns;
  const at = sql`${options.nowLiteral}`;
  const minsAgo = (minutes: number) => dateSub(at, { minutes });
  const recentBuckets = and(
    eq(b.post_id, posts.columns.id),
    gte(b.bucket_start, minsAgo(120)),
    lte(b.bucket_start, at),
  );
  const postFilter = options.postId === undefined
    ? eq(posts.columns.status, "published")
    : eq(posts.columns.id, options.postId);

  return db.$with("score_windows").as(
    db.select({
      post_id: posts.columns.id,
      last_15m_score: sql`coalesce(${
        filter(
          sum(b.activity_score),
          and(gte(b.bucket_start, minsAgo(15)), lte(b.bucket_start, at)),
        )
      }, 0)`,
      last_60m_score: sql`coalesce(${
        filter(
          sum(b.activity_score),
          and(gte(b.bucket_start, minsAgo(60)), lte(b.bucket_start, at)),
        )
      }, 0)`,
      previous_60m_score: sql`coalesce(${
        filter(
          sum(b.activity_score),
          and(
            gte(b.bucket_start, minsAgo(120)),
            lt(b.bucket_start, minsAgo(60)),
          ),
        )
      }, 0)`,
    })
      .from(posts)
      .leftJoin(postActivityBuckets, recentBuckets)
      .where(postFilter)
      .groupBy(posts.columns.id),
  );
}

function computedScoreCte(
  db: MysqlDatabase,
  scoreWindows: ReturnType<
    typeof scoreWindowsCte
  >,
) {
  return db.$with("computed_score").as(
    db.select({
      post_id: scoreWindows.post_id,
      last_15m_score: scoreWindows.last_15m_score,
      last_60m_score: scoreWindows.last_60m_score,
      previous_60m_score: scoreWindows.previous_60m_score,
      acceleration_bonus:
        sql`greatest(${scoreWindows.last_15m_score} - (${scoreWindows.previous_60m_score} / 4.0), 0)`,
      rising_score:
        sql`(${scoreWindows.last_15m_score} * 3.0 + ${scoreWindows.last_60m_score} + greatest(${scoreWindows.last_15m_score} - (${scoreWindows.previous_60m_score} / 4.0), 0) * 2.0)`,
    }).from(scoreWindows),
  );
}

async function readComputedScores(
  db: MysqlDatabase,
  options: { readonly nowLiteral: string; readonly postId?: string },
): Promise<RecomputedPostCtes[]> {
  const scoreWindows = scoreWindowsCte(db, options);
  const computedScore = computedScoreCte(db, scoreWindows);
  return await db.with(scoreWindows, computedScore)
    .select({
      id: computedScore.post_id,
      rising_score: computedScore.rising_score,
      rising_score_updated_at: sql`${options.nowLiteral}`,
      last_15m_score: computedScore.last_15m_score,
      last_60m_score: computedScore.last_60m_score,
      previous_60m_score: computedScore.previous_60m_score,
      acceleration_bonus: computedScore.acceleration_bonus,
    })
    .from(computedScore)
    .execute() as RecomputedPostCtes[];
}

async function writeComputedScores(
  db: MysqlDatabase,
  options: { readonly nowLiteral: string; readonly postId?: string },
): Promise<void> {
  if (db.dialectIdentity.variant === "mariadb") {
    await writeComputedScoresFallback(db, options);
    return;
  }

  const scoreWindows = scoreWindowsCte(db, options);
  const computedScore = computedScoreCte(db, scoreWindows);
  await db.with(scoreWindows, computedScore)
    .update(posts)
    .set({
      rising_score: sql`${computedScore.rising_score}`,
      rising_score_updated_at: options.nowLiteral,
      updated_at: options.nowLiteral,
    })
    .from(computedScore)
    .where(eq(posts.columns.id, computedScore.post_id))
    .execute();
}

async function writeComputedScoresFallback(
  db: MysqlDatabase,
  options: { readonly nowLiteral: string; readonly postId?: string },
): Promise<void> {
  const rows = await readComputedScores(db, options);
  if (rows.length === 0) return;
  await db.batch(
    rows.map((row) =>
      db.update(posts)
        .set({
          rising_score: Number(row.rising_score),
          rising_score_updated_at: options.nowLiteral,
          updated_at: options.nowLiteral,
        })
        .where(eq(posts.columns.id, row.id))
    ),
  );
}

async function main(): Promise<void> {
  const { openDb } = await import("./db.ts");
  const db = await openDb();
  try {
    const now = new Date();
    const updated = await recomputeAllRisingScoresCtes(db, { now });
    console.log(
      `recomputed rising_score (CTE strategy) for ${updated} post(s) at ${
        mysqlTimestamp(now)
      }.`,
    );
  } finally {
    await db.close();
  }
}

if (import.meta.main) {
  await main();
}
