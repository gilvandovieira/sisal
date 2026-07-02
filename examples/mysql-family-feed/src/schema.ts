/**
 * Typed `defineTable` models for posts, activity buckets, and activity actors
 * on MySQL/MariaDB.
 *
 * MySQL cannot key `TEXT`, so ids are `varchar(36)` UUID strings. Times are
 * `DATETIME(6)` strings in the adapter's safe UTC literal format
 * (`YYYY-MM-DD HH:mm:ss.SSS000`), not ISO strings with a trailing `Z`.
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
import { mysqlTimestamp } from "./rising.ts";

/** A row in `posts`, as read back from the database. */
export const posts = defineTable("posts", {
  id: columns.varchar(36).primaryKey(),
  title: columns.varchar(255).notNull(),
  body: columns.text().optional(),
  status: columns.varchar(40).notNull().default("published"),
  score: columns.integer().notNull().default(0),
  rising_score: columns.doublePrecision().notNull().default(0),
  rising_score_updated_at: columns.timestamp({ mode: "string" }),
  created_at: columns.timestamp({ mode: "string" }).notNull().default(() =>
    mysqlTimestamp(new Date())
  ),
  updated_at: columns.timestamp({ mode: "string" }).notNull().default(() =>
    mysqlTimestamp(new Date())
  ),
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
  post_id: columns.varchar(36).notNull().references("posts", "id", {
    onDelete: "cascade",
  }),
  bucket_start: columns.timestamp({ mode: "string" }).notNull(),
  upvotes: columns.integer().notNull().default(0),
  downvotes: columns.integer().notNull().default(0),
  comments: columns.integer().notNull().default(0),
  reports: columns.integer().notNull().default(0),
  unique_actors: columns.integer().notNull().default(0),
  activity_score: columns.doublePrecision().notNull().default(0),
  created_at: columns.timestamp({ mode: "string" }).notNull().default(() =>
    mysqlTimestamp(new Date())
  ),
  updated_at: columns.timestamp({ mode: "string" }).notNull().default(() =>
    mysqlTimestamp(new Date())
  ),
}, (c) => [
  primaryKey({ columns: [c.post_id, c.bucket_start] }),
  index("post_activity_buckets_post_bucket_idx")
    .on(c.post_id, desc(c.bucket_start)),
  index("post_activity_buckets_bucket_idx").on(desc(c.bucket_start)),
]);

/** A row in `post_activity_actors`: one actor's first touch in a bucket. */
export const postActivityActors = defineTable("post_activity_actors", {
  post_id: columns.varchar(36).notNull().references("posts", "id", {
    onDelete: "cascade",
  }),
  bucket_start: columns.timestamp({ mode: "string" }).notNull(),
  actor_id: columns.varchar(36).notNull(),
  created_at: columns.timestamp({ mode: "string" }).notNull().default(() =>
    mysqlTimestamp(new Date())
  ),
}, (c) => [
  primaryKey({ columns: [c.post_id, c.bucket_start, c.actor_id] }),
]);

/** Inferred select-row type for a post. */
export type Post = InferSelect<typeof posts>;

/** Inferred select-row type for an activity bucket. */
export type ActivityBucket = InferSelect<typeof postActivityBuckets>;
