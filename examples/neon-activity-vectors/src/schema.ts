/**
 * Typed `defineTable` models for the activity-vectors computation chain.
 *
 * These mirror migrations/0001_init.sql and type the builder-native paths
 * (seeding events, reading stats). The set-based computation — folding events
 * into buckets, the window-function moving averages, the rollups — lives in the
 * SQL functions in 0002 (see the README "Sisal API pressure points"); the `.sql`
 * migrations are the source of truth.
 *
 * IDs are `bigint`/`bigserial`, which Sisal types as `string` to preserve 64-bit
 * precision — so post/actor ids are strings in TypeScript. `integer` infers
 * `number`; `double precision` infers `number`. Timestamps use `mode: "date"`.
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

/** A post, with the stored hot/rising scores the vector reuses. */
export const posts = defineTable("posts", {
  id: columns.bigserial().primaryKey(),
  title: columns.text().notNull(),
  body: columns.text().optional(),
  status: columns.text().notNull().default("published"),
  hot_score: columns.doublePrecision().notNull().default(0),
  rising_score: columns.doublePrecision().notNull().default(0),
  created_at: columns.timestamp({ withTimezone: true, mode: "date" }).notNull()
    .default(() => new Date()),
  updated_at: columns.timestamp({ withTimezone: true, mode: "date" }).notNull()
    .default(() => new Date()),
}, (c) => [
  index("posts_created_idx").on(c.status, desc(c.created_at), desc(c.id)),
]);

/** A raw activity event: one row per action, folded into buckets later. */
export const postEvents = defineTable("post_events", {
  id: columns.bigserial().primaryKey(),
  post_id: columns.bigint().notNull().references("posts", "id", {
    onDelete: "cascade",
  }),
  actor_id: columns.bigint(),
  event_type: columns.text().notNull(),
  value: columns.integer().notNull().default(1),
  created_at: columns.timestamp({ withTimezone: true, mode: "date" }).notNull()
    .default(() => new Date()),
}, (c) => [
  index("post_events_post_created_idx").on(c.post_id, c.created_at),
  index("post_events_created_idx").on(c.created_at),
]);

/** One (post, hour) bucket, folded from events. */
export const postActivityBuckets = defineTable("post_activity_buckets", {
  post_id: columns.bigint().notNull().references("posts", "id", {
    onDelete: "cascade",
  }),
  bucket_start: columns.timestamp({ withTimezone: true, mode: "date" })
    .notNull(),
  votes: columns.integer().notNull().default(0),
  comments: columns.integer().notNull().default(0),
  reports: columns.integer().notNull().default(0),
  unique_actors: columns.integer().notNull().default(0),
}, (c) => [
  primaryKey({ columns: [c.post_id, c.bucket_start] }),
  index("post_activity_buckets_post_bucket_idx")
    .on(c.post_id, desc(c.bucket_start)),
]);

/** The consolidated feature row — each feature its own queryable column. */
export const postActivityStats = defineTable("post_activity_stats", {
  post_id: columns.bigint().primaryKey().references("posts", "id", {
    onDelete: "cascade",
  }),
  votes_1h: columns.integer().notNull(),
  comments_1h: columns.integer().notNull(),
  reports_1h: columns.integer().notNull(),
  unique_actors_1h: columns.integer().notNull(),
  vote_ma_6h: columns.doublePrecision().notNull(),
  comment_ma_6h: columns.doublePrecision().notNull(),
  hot_score: columns.doublePrecision().notNull(),
  rising_score: columns.doublePrecision().notNull(),
  age_minutes: columns.doublePrecision().notNull(),
  computed_at: columns.timestamp({ withTimezone: true, mode: "date" })
    .notNull(),
});

/** Daily rollup of the hourly buckets (retention tier 2). */
export const postActivityDaily = defineTable("post_activity_daily", {
  post_id: columns.bigint().notNull().references("posts", "id", {
    onDelete: "cascade",
  }),
  day_start: columns.timestamp({ withTimezone: true, mode: "date" }).notNull(),
  votes: columns.integer().notNull().default(0),
  comments: columns.integer().notNull().default(0),
  reports: columns.integer().notNull().default(0),
  unique_actors: columns.integer().notNull().default(0),
  active_hours: columns.integer().notNull().default(0),
}, (c) => [
  primaryKey({ columns: [c.post_id, c.day_start] }),
]);

/** Monthly rollup of the daily rollups (retention tier 3). */
export const postActivityMonthly = defineTable("post_activity_monthly", {
  post_id: columns.bigint().notNull().references("posts", "id", {
    onDelete: "cascade",
  }),
  month_start: columns.timestamp({ withTimezone: true, mode: "date" })
    .notNull(),
  votes: columns.integer().notNull().default(0),
  comments: columns.integer().notNull().default(0),
  reports: columns.integer().notNull().default(0),
  unique_actors: columns.integer().notNull().default(0),
  active_days: columns.integer().notNull().default(0),
}, (c) => [
  primaryKey({ columns: [c.post_id, c.month_start] }),
]);

/** Inferred select-row type for a post. */
export type Post = InferSelect<typeof posts>;

/** Inferred select-row type for a consolidated stats row. */
export type PostActivityStats = InferSelect<typeof postActivityStats>;
