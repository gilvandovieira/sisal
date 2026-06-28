/**
 * The two timelines: `/new` and `/rising`.
 *
 * Unlike the mutations (which are raw CTEs), the feeds are **builder-native**.
 * Sisal's `.keyset({ orderBy, after })` expresses both the simple `/new` keyset
 * and the three-column `/rising` keyset over a computed score — so keyset
 * pagination is NOT a raw-SQL pressure point here (see the README). Both use
 * keyset (cursor) pagination, never OFFSET, so deep pages stay cheap and don't
 * shift when rows change between requests; each `orderBy` ends with the unique
 * `id` to make the order total.
 *
 * @module
 */

import { and, desc, eq, gt } from "@sisal/orm";
import type { NeonDatabase } from "./db.ts";
import { posts } from "./schema.ts";

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
