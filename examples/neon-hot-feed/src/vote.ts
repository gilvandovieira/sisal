/**
 * Casting a vote: one statement, atomically.
 *
 * The multi-step read-modify-write (look up the prior vote, upsert/delete it,
 * recompute the post's aggregates and hot_score) lives in the PostgreSQL
 * function `app.vote_post`. Here we call it as a single parameterized statement,
 * so there is no interactive transaction callback and no connection held open
 * across round trips — the Deno Deploy + Neon HTTP friendly shape.
 *
 * @module
 */

import { sql } from "@sisal/orm";
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
 * Records `userId`'s vote on `postId` and returns the post's new aggregates.
 *
 * Values are bound parameters and cast in SQL — never string-concatenated.
 */
export async function votePost(
  db: NeonDatabase,
  postId: string,
  userId: string,
  value: VoteValue,
): Promise<VoteResult> {
  const result = await db.query<VoteResult>(
    sql`select * from app.vote_post(${postId}::uuid, ${userId}::uuid, ${value}::smallint)`,
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`vote_post returned no row for post ${postId}`);
  }
  return row;
}
