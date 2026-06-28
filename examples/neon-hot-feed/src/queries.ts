/**
 * The two timelines: `/new` and `/hot`.
 *
 * Both use keyset (cursor) pagination — never OFFSET — so deep pages stay cheap
 * and pages do not shift when rows are inserted between requests.
 *
 * - `getNewFeed` is written with the Sisal query builder. The `(created_at, id)`
 *   keyset is expressible with `and`/`or`/`lt`/`eq`, so no raw SQL is needed.
 * - `getHotFeed` drops to a raw `sql` template. The three-column keyset over a
 *   computed `double precision` ranking column, plus matching DESC ordering, is
 *   clearer and safer as raw SQL than as nested builder predicates. This is a
 *   deliberate "escape hatch" — see the README "Sisal API pressure points".
 *
 * @module
 */

import { and, desc, eq, lt, or, type Sql, sql } from "@sisal/orm";
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

/** Cursor for the `/new` timeline. */
export interface NewCursor {
  readonly createdAt: Date;
  readonly id: string;
}

/** Cursor for the `/hot` timeline. */
export interface HotCursor {
  readonly hotScore: number;
  readonly createdAt: Date;
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

/**
 * `/new`: newest first, `created_at DESC, id DESC`. Built entirely with the
 * Sisal query builder, including the keyset predicate.
 */
export async function getNewFeed(
  db: NeonDatabase,
  limit: number,
  cursor?: NewCursor,
): Promise<FeedPage<NewCursor>> {
  const take = clampLimit(limit);
  const published = eq(posts.columns.status, "published");

  // Keyset: created_at < c.createdAt OR (created_at = c.createdAt AND id < c.id)
  const where = cursor === undefined ? published : and(
    published,
    or(
      lt(posts.columns.created_at, cursor.createdAt),
      and(
        eq(posts.columns.created_at, cursor.createdAt),
        lt(posts.columns.id, cursor.id),
      ),
    ),
  );

  const rows = await db.select().from(posts).where(where)
    .orderBy(desc(posts.columns.created_at), desc(posts.columns.id))
    .limit(take)
    .execute() as FeedPost[];

  return page(rows, take, (last) => ({
    createdAt: last.created_at,
    id: last.id,
  }));
}

/**
 * `/hot`: highest hot_score first, with `created_at` then `id` as tiebreakers.
 * Written as a raw `sql` template (parameterized) to keep the three-column
 * keyset comparison legible.
 */
export async function getHotFeed(
  db: NeonDatabase,
  limit: number,
  cursor?: HotCursor,
): Promise<FeedPage<HotCursor>> {
  const take = clampLimit(limit);

  const keyset: Sql = cursor === undefined ? sql`` : sql`
    and (
      hot_score < ${cursor.hotScore}
      or (hot_score = ${cursor.hotScore} and created_at < ${cursor.createdAt})
      or (
        hot_score = ${cursor.hotScore}
        and created_at = ${cursor.createdAt}
        and id < ${cursor.id}::uuid
      )
    )`;

  const query = sql`
    select id, title, status, score, upvotes, downvotes, hot_score, created_at
    from posts
    where status = ${"published"}${keyset}
    order by hot_score desc, created_at desc, id desc
    limit ${take}
  `;

  const result = await db.query<FeedPost>(query);

  return page(result.rows, take, (last) => ({
    hotScore: last.hot_score,
    createdAt: last.created_at,
    id: last.id,
  }));
}

function page<TCursor>(
  rows: readonly FeedPost[],
  take: number,
  toCursor: (last: FeedPost) => TCursor,
): FeedPage<TCursor> {
  const full = rows.length === take && rows.length > 0;
  return {
    posts: rows,
    nextCursor: full ? toCursor(rows[rows.length - 1]) : undefined,
  };
}
