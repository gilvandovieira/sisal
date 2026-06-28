/**
 * Typed `defineTable` models for posts and votes.
 *
 * These mirror migrations/0001_init.sql and give the query builder typed
 * columns and row inference (see src/queries.ts and src/seed.ts). Column keys
 * are snake_case on purpose: Sisal uses column names verbatim, so the keys must
 * match the physical column names in the SQL migrations.
 *
 * The `.sql` migrations remain the source of truth for the database shape:
 * Sisal's snapshot DDL generator does not express DESC index ordering, this
 * CHECK shape, or the PostgreSQL functions this example relies on.
 *
 * @module
 */

import {
  check,
  columns,
  defineTable,
  index,
  type InferSelect,
  primaryKey,
  sql,
} from "@sisal/orm";

/** A row in `posts`, as read back from the database. */
export const posts = defineTable("posts", {
  id: columns.uuid().primaryKey(),
  title: columns.text().notNull(),
  body: columns.text().optional(),
  status: columns.text().notNull().default("published"),
  score: columns.integer().notNull().default(0),
  upvotes: columns.integer().notNull().default(0),
  downvotes: columns.integer().notNull().default(0),
  hot_score: columns.doublePrecision().notNull().default(0),
  created_at: columns.timestamp({ withTimezone: true }).notNull().default(
    () => new Date(),
  ),
  updated_at: columns.timestamp({ withTimezone: true }).notNull().default(
    () => new Date(),
  ),
}, (c) => [
  index("posts_new_feed_idx").on(c.status, c.created_at, c.id),
  index("posts_hot_feed_idx").on(c.status, c.hot_score, c.created_at, c.id),
]);

/** A row in `post_votes`; only -1 / 1 are ever stored (0 means delete). */
export const postVotes = defineTable("post_votes", {
  post_id: columns.uuid().notNull().references("posts", "id", {
    onDelete: "cascade",
  }),
  user_id: columns.uuid().notNull(),
  value: columns.smallint().notNull(),
  created_at: columns.timestamp({ withTimezone: true }).notNull().default(
    () => new Date(),
  ),
  updated_at: columns.timestamp({ withTimezone: true }).notNull().default(
    () => new Date(),
  ),
}, (c) => [
  primaryKey({ columns: [c.post_id, c.user_id] }),
  check("post_votes_value_check", sql`value in (-1, 1)`),
  index("post_votes_user_idx").on(c.user_id),
  index("post_votes_post_idx").on(c.post_id),
]);

/** Inferred select-row type for a post. */
export type Post = InferSelect<typeof posts>;
