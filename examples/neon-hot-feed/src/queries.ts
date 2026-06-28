/**
 * The two timelines: `/new` and `/hot`.
 *
 * Both use keyset (cursor) pagination — never OFFSET — so deep pages stay cheap
 * and pages do not shift when rows are inserted between requests. Both are now
 * fully builder-native via `.keyset({ orderBy, after })`:
 *
 * - `getNewFeed` keysets over `(created_at, id)` in the default expanded
 *   `or`/`and` form.
 * - `getHotFeed` keysets over `(hot_score, created_at, id)` using the row-value
 *   form (`(a, b, c) < (x, y, z)`), which reads cleanly for a uniform DESC sort.
 *
 * Each `orderBy` ends with the unique `id`, which makes the keyset a total order
 * and sidesteps the timestamp-precision pitfall at page boundaries.
 *
 * @module
 */

import { desc, eq } from "@sisal/orm";
import type { NeonDatabase } from "@sisal/neon";
import { posts } from "./schema.ts";

/** A post as rendered in a feed. */
export interface FeedPost {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly score: number;
  readonly upvotes: number;
  readonly downvotes: number;
  readonly hot_score: number;
  readonly created_at: Date;
}

/** Cursor for the `/new` timeline (keyed by the ordered columns). */
export interface NewCursor {
  readonly created_at: Date;
  readonly id: string;
}

/** Cursor for the `/hot` timeline (keyed by the ordered columns). */
export interface HotCursor {
  readonly hot_score: number;
  readonly created_at: Date;
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

/** `/new`: newest first, `created_at DESC, id DESC`, keyset-paginated. */
export async function getNewFeed(
  db: NeonDatabase,
  limit: number,
  cursor?: NewCursor,
): Promise<FeedPage<NewCursor>> {
  const page = await db.select().from(posts)
    .where(eq(posts.columns.status, "published"))
    .keyset({
      orderBy: [desc(posts.columns.created_at), desc(posts.columns.id)],
      after: cursor,
    })
    .limit(clampLimit(limit))
    .execute();

  return { posts: page.rows, nextCursor: page.nextCursor ?? undefined };
}

/** `/hot`: `hot_score DESC, created_at DESC, id DESC`, keyset-paginated. */
export async function getHotFeed(
  db: NeonDatabase,
  limit: number,
  cursor?: HotCursor,
): Promise<FeedPage<HotCursor>> {
  const page = await db.select().from(posts)
    .where(eq(posts.columns.status, "published"))
    .keyset({
      orderBy: [
        desc(posts.columns.hot_score),
        desc(posts.columns.created_at),
        desc(posts.columns.id),
      ],
      after: cursor,
      form: "row-value",
    })
    .limit(clampLimit(limit))
    .execute();

  return { posts: page.rows, nextCursor: page.nextCursor ?? undefined };
}
