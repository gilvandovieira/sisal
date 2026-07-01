/**
 * Casting a vote: one statement, atomically.
 *
 * The multi-step read-modify-write (look up the prior vote, upsert/delete it,
 * recompute the post's aggregates and hot_score) lives in the PostgreSQL
 * function `app.vote_post`. We declare it once as a typed `defineFunction`
 * descriptor and call it with `db.call(...).one()` — a single parameterized
 * statement with the `::uuid` / `::smallint` casts taken from the argument
 * column types, so there is no raw `sql` string, no interactive transaction
 * callback, and no connection held open across round trips (the Deno Deploy +
 * Neon HTTP friendly shape).
 *
 * @module
 */

import { columns, defineFunction } from "@sisal/orm";
import type { NeonDatabase } from "@sisal/neon";

/** A vote direction: 1 up, -1 down, 0 removes any existing vote. */
export type VoteValue = -1 | 0 | 1;

/** The post aggregates returned by `app.vote_post` after a vote. */
export interface VoteResult {
  readonly id: string;
  readonly score: number;
  readonly upvotes: number;
  readonly downvotes: number;
  readonly hot_score: number;
}

/**
 * Typed descriptor for `app.vote_post(post_id uuid, user_id uuid, value
 * smallint) RETURNS TABLE (...)`. Arguments are positional and cast from these
 * column types; the result row is typed from `returns`.
 */
const votePostFn = defineFunction("app.vote_post", {
  args: {
    postId: columns.uuid(),
    userId: columns.uuid(),
    value: columns.smallint(),
  },
  returns: {
    id: columns.uuid().notNull(),
    score: columns.integer().notNull(),
    upvotes: columns.integer().notNull(),
    downvotes: columns.integer().notNull(),
    hot_score: columns.doublePrecision().notNull(),
  },
});

/**
 * Records `userId`'s vote on `postId` and returns the post's new aggregates.
 *
 * Values are bound parameters and cast in SQL — never string-concatenated.
 * `.one()` asserts the function returned exactly one row.
 */
export function votePost(
  db: NeonDatabase,
  postId: string,
  userId: string,
  value: VoteValue,
): Promise<VoteResult> {
  return db.call(votePostFn, { postId, userId, value }).one();
}
