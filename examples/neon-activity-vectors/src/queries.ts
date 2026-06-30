/**
 * The secondary payoff: "posts that behaved like this post."
 *
 * The centerpiece of this example is the computation chain (events → buckets →
 * window-function moving averages → consolidated stats → vector projection); the
 * similarity below is what makes the vectors tangible. Two implementations:
 *
 * - {@link getSimilarPosts} — load the stats rows, project to vectors, score in
 *   TypeScript with {@link cosineSimilarity}. Builder-native + pure math.
 * - {@link getSimilarPostsSql} — score in Postgres via `app.cosine_similarity`
 *   over `app.post_activity_vector(...)` (raw SQL; a documented pressure point).
 *
 * @module
 */

import { sql } from "@sisal/orm";
import type { NeonDatabase } from "./db.ts";
import { postActivityStats, posts } from "./schema.ts";
import { statsToVector } from "./stats.ts";
import { cosineSimilarity } from "./vector.ts";

/** A candidate post and its cosine similarity to the source post. */
export interface SimilarPost {
  readonly id: string;
  readonly title: string;
  readonly similarity: number;
}

/**
 * Posts most similar to `postId` by cosine over the projected activity vectors,
 * source excluded, highest first. Loads all stats rows and scores in TypeScript.
 */
export async function getSimilarPosts(
  db: NeonDatabase,
  postId: string,
  limit: number,
): Promise<SimilarPost[]> {
  const stats = await db.select().from(postActivityStats).execute();
  const titles = await db
    .select({ id: posts.columns.id, title: posts.columns.title })
    .from(posts).execute();
  const titleOf = new Map(titles.map((t) => [t.id, t.title]));

  const source = stats.find((s) => s.post_id === postId);
  if (source === undefined) {
    throw new Error(`getSimilarPosts: no stats for post ${postId}`);
  }
  const sourceVector = statsToVector(source);

  return stats
    .filter((s) => s.post_id !== postId)
    .map((s) => ({
      id: s.post_id,
      title: titleOf.get(s.post_id) ?? "?",
      similarity: cosineSimilarity(sourceVector, statsToVector(s)),
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, Math.max(0, Math.trunc(limit)));
}

/**
 * Same ranking, scored in Postgres: `app.cosine_similarity` over the SQL
 * `app.post_activity_vector` projection. Raw SQL — a documented pressure point.
 */
export async function getSimilarPostsSql(
  db: NeonDatabase,
  postId: string,
  limit: number,
): Promise<SimilarPost[]> {
  const result = await db.query<
    { id: string; title: string; similarity: number }
  >(sql`
    select
      p.id,
      p.title,
      app.cosine_similarity(
        app.post_activity_vector(${postId}::bigint),
        app.post_activity_vector(s.post_id)
      ) as similarity
    from post_activity_stats s
    join posts p on p.id = s.post_id
    where s.post_id <> ${postId}::bigint
    order by similarity desc
    limit ${Math.max(0, Math.trunc(limit))}
  `);
  return result.rows.map((r) => ({
    id: String(r.id),
    title: r.title,
    similarity: Number(r.similarity),
  }));
}
