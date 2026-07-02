import { columns, defineTable, primaryKey } from "@sisal/orm";

/** Posts used by the advanced SQL contracts. */
export const posts = defineTable("sisal_adv_posts", {
  id: columns.integer().primaryKey(),
  community_id: columns.integer().notNull(),
  title: columns.text().notNull(),
  status: columns.text().notNull().default("published"),
  created_at: columns.timestamp({ withTimezone: true, mode: "date" })
    .notNull(),
  hot_score: columns.doublePrecision().notNull().default(0),
});

/** Event stream used for rollups, funnels, cohorts, and sessionization. */
export const events = defineTable("sisal_adv_events", {
  id: columns.integer().primaryKey(),
  post_id: columns.integer().notNull(),
  actor_id: columns.integer().notNull(),
  kind: columns.text().notNull(),
  value: columns.integer().notNull().default(1),
  occurred_at: columns.timestamp({ withTimezone: true, mode: "date" })
    .notNull(),
});

/** Hourly rollup table maintained by the ETL examples. */
export const hourlyStats = defineTable("sisal_adv_hourly_stats", {
  post_id: columns.integer().notNull(),
  bucket: columns.timestamp({ withTimezone: true, mode: "date" }).notNull(),
  views: columns.integer().notNull(),
  votes: columns.integer().notNull(),
  comments: columns.integer().notNull(),
  engagement_score: columns.doublePrecision().notNull(),
}, (c) => [primaryKey({ columns: [c.post_id, c.bucket] })]);

/** Threaded comments for the recursive CTE contract. */
export const comments = defineTable("sisal_adv_comments", {
  id: columns.integer().primaryKey(),
  parent_id: columns.integer(),
  body: columns.text().notNull(),
});

/** Queue rows for row-locking examples. */
export const jobs = defineTable("sisal_adv_jobs", {
  id: columns.integer().primaryKey(),
  status: columns.text().notNull(),
  priority: columns.integer().notNull(),
  locked_by: columns.text(),
  locked_at: columns.timestamp({ withTimezone: true, mode: "date" }),
});

/** Checkpoint table for idempotent backfill examples. */
export const backfillState = defineTable("sisal_adv_backfill_state", {
  name: columns.text().primaryKey(),
  high_watermark: columns.timestamp({ withTimezone: true, mode: "date" })
    .notNull(),
  updated_at: columns.timestamp({ withTimezone: true, mode: "date" })
    .notNull(),
});

export const schemaTables = [
  posts,
  events,
  hourlyStats,
  comments,
  jobs,
  backfillState,
] as const;
