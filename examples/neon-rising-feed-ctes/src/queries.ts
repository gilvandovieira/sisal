/**
 * The two timelines (`/new`, `/rising`) plus the builder-native rising-score
 * read.
 *
 * Unlike the data-modifying mutations (which stay raw CTEs), these are
 * **builder-native**. Sisal's `.keyset({ orderBy, after })` expresses both the
 * simple `/new` keyset and the three-column `/rising` keyset over a computed
 * score — so keyset pagination is NOT a raw-SQL pressure point here (see the
 * README). Both feeds use keyset (cursor) pagination, never OFFSET, so deep
 * pages stay cheap and don't shift when rows change between requests; each
 * `orderBy` ends with the unique `id` to make the order total.
 * {@link selectRisingScore} additionally computes the moving-window score with
 * `filter` + `dateSub` — the same aggregate the recompute CTE runs, no longer
 * needing the raw-SQL escape hatch (v0.5.0 roadmap item 9).
 *
 * @module
 */

import {
  and,
  dateSub,
  desc,
  eq,
  filter,
  gt,
  gte,
  lt,
  lte,
  sql,
  sum,
} from "@sisal/orm";
import type { NeonDatabase } from "./db.ts";
import { postActivityBuckets, posts } from "./schema.ts";
import { RISING } from "./rising.ts";

/** A post as rendered in a feed. */
export interface FeedPost {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly rising_score: number;
  readonly rising_score_updated_at: Date | null;
  readonly created_at: Date;
}

/** Cursor for the `/new` timeline (keyed by the ordered columns). */
export interface NewCursor {
  readonly created_at: Date;
  readonly id: string;
}

/** Cursor for the `/rising` timeline (keyed by the ordered columns). */
export interface RisingCursor {
  readonly rising_score: number;
  readonly rising_score_updated_at: Date | null;
  readonly id: string;
}

/** A page of feed rows plus the cursor to fetch the next page (if any). */
export interface FeedPage<TCursor> {
  readonly posts: readonly FeedPost[];
  readonly nextCursor: TCursor | undefined;
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 20;
  return Math.min(100, Math.max(1, Math.trunc(limit)));
}

const FEED_COLUMNS = {
  id: posts.columns.id,
  title: posts.columns.title,
  status: posts.columns.status,
  rising_score: posts.columns.rising_score,
  rising_score_updated_at: posts.columns.rising_score_updated_at,
  created_at: posts.columns.created_at,
} as const;

/** `/new`: newest first, `created_at DESC, id DESC`, keyset-paginated. */
export async function getNewFeed(
  db: NeonDatabase,
  limit: number,
  cursor?: NewCursor,
): Promise<FeedPage<NewCursor>> {
  const page = await db.select(FEED_COLUMNS).from(posts)
    .where(eq(posts.columns.status, "published"))
    .keyset({
      orderBy: [desc(posts.columns.created_at), desc(posts.columns.id)],
      after: cursor,
    })
    .limit(clampLimit(limit))
    .execute();

  return { posts: page.rows, nextCursor: page.nextCursor ?? undefined };
}

/** A post's moving-window score parts + final rising score at a reference time. */
export interface RisingScoreWindows {
  readonly last_15m_score: number;
  readonly last_60m_score: number;
  readonly previous_60m_score: number;
  readonly acceleration_bonus: number;
  readonly rising_score: number;
}

/**
 * Computes a post's moving-window rising score at `now`, **builder-native** —
 * the same `score_windows` aggregate the recompute CTE in src/rising.ts runs,
 * now expressed with `filter(sum(...), …)` + `dateSub` instead of raw SQL (v0.5.0
 * roadmap item 9). Read-only: it does not store the score; the atomic
 * `UPDATE … FROM` recompute remains a CTE (the fluent builder still can't write
 * one), so only the windowed aggregate moves out of the raw-SQL escape hatch.
 *
 * Determinism matches the CTE and {@link calculateRisingScoreTs}: `now` is the
 * caller's reference time, windows are bounded `<= now`, and old buckets fall
 * out as `now` advances.
 */
export async function selectRisingScore(
  db: NeonDatabase,
  args: { readonly postId: string; readonly now: Date },
): Promise<RisingScoreWindows> {
  const b = postActivityBuckets.columns;
  // The caller pins `now` (deterministic); type it once for Postgres.
  const at = sql`${args.now}::timestamptz`;
  const since = (minutes: number) =>
    gte(b.bucket_start, dateSub(at, { minutes }));
  const upToNow = lte(b.bucket_start, at);

  const [row] = await db.select({
    last_15m_score: filter(sum(b.activity_score), and(since(15), upToNow)),
    last_60m_score: filter(sum(b.activity_score), and(since(60), upToNow)),
    previous_60m_score: filter(
      sum(b.activity_score),
      and(since(120), lt(b.bucket_start, dateSub(at, { minutes: 60 }))),
    ),
  }).from(postActivityBuckets)
    .where(and(eq(b.post_id, args.postId), since(120), upToNow))
    .execute();

  // Empty windows aggregate to SQL NULL; coalesce to 0 like the CTE does.
  const last15 = Number(row?.last_15m_score ?? 0);
  const last60 = Number(row?.last_60m_score ?? 0);
  const prev60 = Number(row?.previous_60m_score ?? 0);
  const accel = Math.max(last15 - prev60 / 4, 0);
  return {
    last_15m_score: last15,
    last_60m_score: last60,
    previous_60m_score: prev60,
    acceleration_bonus: accel,
    rising_score: last15 * RISING.last15mWeight +
      last60 * RISING.last60mWeight +
      accel * RISING.accelWeight,
  };
}

/**
 * `/rising`: `rising_score DESC, rising_score_updated_at DESC, id DESC`,
 * keyset-paginated, restricted to posts with `rising_score > 0`. The
 * three-column keyset predicate is the row-value form
 * `(rising_score, rising_score_updated_at, id) < (…)`.
 */
export async function getRisingFeed(
  db: NeonDatabase,
  limit: number,
  cursor?: RisingCursor,
): Promise<FeedPage<RisingCursor>> {
  const page = await db.select(FEED_COLUMNS).from(posts)
    .where(and(
      eq(posts.columns.status, "published"),
      gt(posts.columns.rising_score, 0),
    ))
    .keyset({
      orderBy: [
        desc(posts.columns.rising_score),
        desc(posts.columns.rising_score_updated_at),
        desc(posts.columns.id),
      ],
      after: cursor,
      form: "row-value",
    })
    .limit(clampLimit(limit))
    .execute();

  return { posts: page.rows, nextCursor: page.nextCursor ?? undefined };
}
