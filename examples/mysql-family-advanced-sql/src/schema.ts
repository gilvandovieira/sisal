import { columns, defineTable, primaryKey } from "@sisal/orm";

export const posts = defineTable("sisal_adv_posts", {
  id: columns.serial().primaryKey(),
  community_id: columns.integer().notNull(),
  title: columns.varchar(255).notNull(),
  status: columns.varchar(32).notNull().default("published"),
  created_at: columns.timestamp({ mode: "string" }).notNull(),
  hot_score: columns.doublePrecision().notNull().default(0),
});

export const events = defineTable("sisal_adv_events", {
  id: columns.serial().primaryKey(),
  post_id: columns.integer().notNull(),
  actor_id: columns.integer().notNull(),
  kind: columns.varchar(32).notNull(),
  value: columns.integer().notNull().default(1),
  occurred_at: columns.timestamp({ mode: "string" }).notNull(),
});

export const hourlyStats = defineTable("sisal_adv_hourly_stats", {
  post_id: columns.integer().notNull(),
  bucket: columns.timestamp({ mode: "string" }).notNull(),
  views: columns.integer().notNull(),
  votes: columns.integer().notNull(),
  comments: columns.integer().notNull(),
  engagement_score: columns.doublePrecision().notNull(),
}, (c) => [primaryKey({ columns: [c.post_id, c.bucket] })]);

export const comments = defineTable("sisal_adv_comments", {
  id: columns.integer().primaryKey(),
  parent_id: columns.integer(),
  body: columns.varchar(255).notNull(),
});

export const jobs = defineTable("sisal_adv_jobs", {
  id: columns.integer().primaryKey(),
  status: columns.varchar(32).notNull(),
  priority: columns.integer().notNull(),
  locked_by: columns.varchar(120),
  locked_at: columns.timestamp({ mode: "string" }),
});

export const backfillState = defineTable("sisal_adv_backfill_state", {
  name: columns.varchar(120).primaryKey(),
  high_watermark: columns.timestamp({ mode: "string" }).notNull(),
  updated_at: columns.timestamp({ mode: "string" }).notNull(),
});

export const schemaTables = [
  posts,
  events,
  hourlyStats,
  comments,
  jobs,
  backfillState,
] as const;
