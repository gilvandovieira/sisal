/**
 * Typed `defineTable` models for posts, activity buckets, and activity actors
 * on SQLite (libSQL/Turso).
 *
 * These mirror migrations/0001_init.sql and give the query builder typed
 * columns and row inference. SQLite has no `uuid`/`timestamptz` types, so ids
 * and timestamps are `text` here (ISO-8601 UTC strings for time), and scores
 * are `real`. Column keys are snake_case so they line up 1:1 with the SQL.
 *
 * The `.sql` migration remains the source of truth for the database shape; this
 * is the typed mirror the builder uses. Unlike the Neon sibling there are no
 * database functions to mirror — that logic is in TypeScript.
 *
 * @module
 */

import {
  columns,
  defineTable,
  desc,
  index,
  type InferSelect,
  primaryKey,
} from "@sisal/orm";

/** A row in `posts`, as read back from the database. */
export const posts = defineTable("posts", {
  id: columns.text().primaryKey(),
  title: columns.text().notNull(),
  body: columns.text().optional(),
  status: columns.text().notNull().default("published"),
  score: columns.integer().notNull().default(0),
  // Stored, indexable, TIME-DEPENDENT ranking value (recomputed at an explicit
  // `now`). See src/rising.ts.
  rising_score: columns.real().notNull().default(0),
  // ISO string; null until the first recompute. Nullable but still required on
  // insert in Sisal, so seeds pass an explicit null (we avoid `.optional()`,
  // which currently widens the SELECT type — see the README pressure points).
  rising_score_updated_at: columns.text(),
  created_at: columns.text().notNull().default(() => new Date().toISOString()),
  updated_at: columns.text().notNull().default(() => new Date().toISOString()),
}, (c) => [
  index("posts_new_feed_idx").on(c.status, desc(c.created_at), desc(c.id)),
  index("posts_rising_feed_idx").on(
    c.status,
    desc(c.rising_score),
    desc(c.rising_score_updated_at),
    desc(c.id),
  ),
]);

/** A row in `post_activity_buckets`: one (post, 5-minute bucket) aggregate. */
export const postActivityBuckets = defineTable("post_activity_buckets", {
  post_id: columns.text().notNull().references("posts", "id", {
    onDelete: "cascade",
  }),
  bucket_start: columns.text().notNull(),
  upvotes: columns.integer().notNull().default(0),
  downvotes: columns.integer().notNull().default(0),
  comments: columns.integer().notNull().default(0),
  reports: columns.integer().notNull().default(0),
  unique_actors: columns.integer().notNull().default(0),
  activity_score: columns.real().notNull().default(0),
  created_at: columns.text().notNull().default(() => new Date().toISOString()),
  updated_at: columns.text().notNull().default(() => new Date().toISOString()),
}, (c) => [
  primaryKey({ columns: [c.post_id, c.bucket_start] }),
  index("post_activity_buckets_post_bucket_idx")
    .on(c.post_id, desc(c.bucket_start)),
  index("post_activity_buckets_bucket_idx").on(desc(c.bucket_start)),
]);

/** A row in `post_activity_actors`: one actor's first touch in a bucket. */
export const postActivityActors = defineTable("post_activity_actors", {
  post_id: columns.text().notNull().references("posts", "id", {
    onDelete: "cascade",
  }),
  bucket_start: columns.text().notNull(),
  actor_id: columns.text().notNull(),
  created_at: columns.text().notNull().default(() => new Date().toISOString()),
}, (c) => [
  primaryKey({ columns: [c.post_id, c.bucket_start, c.actor_id] }),
]);

/** Inferred select-row type for a post. */
export type Post = InferSelect<typeof posts>;

/** Inferred select-row type for an activity bucket. */
export type ActivityBucket = InferSelect<typeof postActivityBuckets>;
