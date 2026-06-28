/**
 * The two timelines: `/new` and `/rising`.
 *
 * Identical in spirit to the Neon sibling — both use keyset (cursor) pagination
 * via `.keyset({ orderBy, after })`, never OFFSET. The only difference is that
 * SQLite timestamps are ISO-8601 TEXT, so the cursor fields are strings rather
 * than `Date`s (they still compare chronologically because the strings are
 * fixed-width UTC). libSQL renders the same SQL as SQLite, so keyset works
 * unchanged.
 *
 * @module
 */

import { and, desc, eq, gt } from "@sisal/orm";
import type { LibsqlDatabase } from "@sisal/libsql";
import { posts } from "./schema.ts";

/** A post as rendered in a feed. */
export interface FeedPost {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly rising_score: number;
  readonly rising_score_updated_at: string | null;
  readonly created_at: string;
}

/** Cursor for the `/new` timeline (keyed by the ordered columns). */
export interface NewCursor {
  readonly created_at: string;
  readonly id: string;
}

/** Cursor for the `/rising` timeline (keyed by the ordered columns). */
export interface RisingCursor {
  readonly rising_score: number;
  readonly rising_score_updated_at: string | null;
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
  db: LibsqlDatabase,
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
 * keyset-paginated, restricted to posts with `rising_score > 0`.
 */
export async function getRisingFeed(
  db: LibsqlDatabase,
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
