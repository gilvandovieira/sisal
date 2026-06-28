/**
 * Typed `defineTable` models for posts, activity buckets, and activity actors.
 *
 * These mirror migrations/0001_init.sql and give the query builder typed
 * columns and row inference (see src/queries.ts and src/seed.ts). Column keys
 * are snake_case so they line up 1:1 with the raw SQL this example uses (the
 * `app.record_post_activity` RETURNS TABLE columns and the moving-window
 * aggregates). They could be camelCase: since 0.4.0 Sisal's default naming
 * strategy maps keys to snake_case columns (and snake_case keys pass through
 * unchanged), so the physical SQL would be identical either way.
 *
 * The `.sql` migrations remain the source of truth for the database shape:
 * Sisal's snapshot DDL generator does not express the PostgreSQL functions this
 * example relies on (item 7 in the v0.5.0 roadmap). The index metadata below is
 * builder-native via the v0.4.0 rich-index DDL (DESC ordering), so it matches
 * the migration verbatim.
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
  // Stored, indexable, TIME-DEPENDENT ranking value (recomputed at an explicit
  // p_now). See src/rising.ts and 0004_rising_score_functions.sql.
  rising_score: columns.doublePrecision().notNull().default(0),
  // Null until the first recompute; part of the /rising keyset tiebreak.
  // Nullable, but Sisal still requires nullable columns on insert (unless
  // `.optional()`/`.default()`), so seeds pass an explicit `null`. We avoid
  // `.optional()` here on purpose: it currently widens the SELECT row type to
  // include `undefined` (see the README "Sisal API pressure points").
  // Defaults to `Temporal.Instant` (Sisal's default for timestamptz); reads are
  // parsed back to Temporal because db.ts opens with `temporal: { parse: true }`.
  rising_score_updated_at: columns.timestamp({ withTimezone: true }),
  created_at: columns.timestamp({ withTimezone: true }).notNull()
    .default(() => Temporal.Now.instant()),
  updated_at: columns.timestamp({ withTimezone: true }).notNull()
    .default(() => Temporal.Now.instant()),
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
  bucket_start: columns.timestamp({ withTimezone: true }).notNull(),
  upvotes: columns.integer().notNull().default(0),
  downvotes: columns.integer().notNull().default(0),
  comments: columns.integer().notNull().default(0),
  reports: columns.integer().notNull().default(0),
  unique_actors: columns.integer().notNull().default(0),
  activity_score: columns.doublePrecision().notNull().default(0),
  created_at: columns.timestamp({ withTimezone: true }).notNull()
    .default(() => Temporal.Now.instant()),
  updated_at: columns.timestamp({ withTimezone: true }).notNull()
    .default(() => Temporal.Now.instant()),
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
  bucket_start: columns.timestamp({ withTimezone: true }).notNull(),
  actor_id: columns.uuid().notNull(),
  created_at: columns.timestamp({ withTimezone: true }).notNull()
    .default(() => Temporal.Now.instant()),
}, (c) => [
  primaryKey({ columns: [c.post_id, c.bucket_start, c.actor_id] }),
]);

/** Inferred select-row type for a post. */
export type Post = InferSelect<typeof posts>;

/** Inferred select-row type for an activity bucket. */
export type ActivityBucket = InferSelect<typeof postActivityBuckets>;
