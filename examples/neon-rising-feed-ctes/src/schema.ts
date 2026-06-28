/**
 * Typed `defineTable` models for posts, activity buckets, and activity actors.
 *
 * These mirror migrations/0001_init.sql and give the query builder typed
 * columns and row inference (see src/queries.ts). Column keys are snake_case so
 * they line up 1:1 with the raw CTE SQL this example uses.
 *
 * Timestamps use `mode: "date"` (JS `Date`); `double precision` columns infer
 * `number`. The `.sql` migration remains the source of truth — Sisal's snapshot
 * DDL generator does not express the DESC indexes (it would on the v0.4.0
 * rich-index path, mirrored below) or the data-modifying CTEs this example
 * relies on. The CTE mutations bypass the builder entirely (see the README
 * "Sisal API pressure points"); these models type the builder-native feeds.
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
  id: columns.uuid().primaryKey(),
  title: columns.text().notNull(),
  body: columns.text().optional(),
  status: columns.text().notNull().default("published"),
  score: columns.integer().notNull().default(0),
  // Stored, indexable, TIME-DEPENDENT ranking value (recomputed at explicit
  // p_now via the CTE in src/rising.ts).
  rising_score: columns.doublePrecision().notNull().default(0),
  // Null until the first recompute; part of the /rising keyset tiebreak.
  // Nullable + no default ⇒ Sisal requires it on insert; seeds pass null.
  rising_score_updated_at: columns.timestamp({
    withTimezone: true,
    mode: "date",
  }),
  created_at: columns.timestamp({ withTimezone: true, mode: "date" }).notNull()
    .default(() => new Date()),
  updated_at: columns.timestamp({ withTimezone: true, mode: "date" }).notNull()
    .default(() => new Date()),
}, (c) => [
  // Keyset feed indexes: leading equality column, then DESC tiebreakers.
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
  post_id: columns.uuid().notNull().references("posts", "id", {
    onDelete: "cascade",
  }),
  bucket_start: columns.timestamp({ withTimezone: true, mode: "date" })
    .notNull(),
  upvotes: columns.integer().notNull().default(0),
  downvotes: columns.integer().notNull().default(0),
  comments: columns.integer().notNull().default(0),
  reports: columns.integer().notNull().default(0),
  unique_actors: columns.integer().notNull().default(0),
  activity_score: columns.doublePrecision().notNull().default(0),
  created_at: columns.timestamp({ withTimezone: true, mode: "date" }).notNull()
    .default(() => new Date()),
  updated_at: columns.timestamp({ withTimezone: true, mode: "date" }).notNull()
    .default(() => new Date()),
}, (c) => [
  primaryKey({ columns: [c.post_id, c.bucket_start] }),
  index("post_activity_buckets_post_bucket_idx")
    .on(c.post_id, desc(c.bucket_start)),
  index("post_activity_buckets_bucket_idx").on(desc(c.bucket_start)),
]);

/** A row in `post_activity_actors`: one actor's first touch in a bucket. */
export const postActivityActors = defineTable("post_activity_actors", {
  post_id: columns.uuid().notNull().references("posts", "id", {
    onDelete: "cascade",
  }),
  bucket_start: columns.timestamp({ withTimezone: true, mode: "date" })
    .notNull(),
  actor_id: columns.uuid().notNull(),
  created_at: columns.timestamp({ withTimezone: true, mode: "date" }).notNull()
    .default(() => new Date()),
}, (c) => [
  primaryKey({ columns: [c.post_id, c.bucket_start, c.actor_id] }),
  index("post_activity_actors_post_bucket_idx").on(c.post_id, c.bucket_start),
]);

/** Inferred select-row type for a post. */
export type Post = InferSelect<typeof posts>;

/** Inferred select-row type for an activity bucket. */
export type ActivityBucket = InferSelect<typeof postActivityBuckets>;
