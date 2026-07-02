import { columns, defineTable, primaryKey } from "@sisal/orm";

export const posts = defineTable("sisal_adv_posts", {
  id: columns.integer().primaryKey(),
  community_id: columns.integer().notNull(),
  title: columns.text().notNull(),
  status: columns.text().notNull().default("published"),
  created_at: columns.text().notNull(),
  hot_score: columns.doublePrecision().notNull().default(0),
});

export const events = defineTable("sisal_adv_events", {
  id: columns.integer().primaryKey(),
  post_id: columns.integer().notNull(),
  actor_id: columns.integer().notNull(),
  kind: columns.text().notNull(),
  value: columns.integer().notNull().default(1),
  occurred_at: columns.text().notNull(),
});

export const hourlyStats = defineTable("sisal_adv_hourly_stats", {
  post_id: columns.integer().notNull(),
  bucket: columns.text().notNull(),
  views: columns.integer().notNull(),
  votes: columns.integer().notNull(),
  comments: columns.integer().notNull(),
  engagement_score: columns.doublePrecision().notNull(),
}, (c) => [primaryKey({ columns: [c.post_id, c.bucket] })]);

export const comments = defineTable("sisal_adv_comments", {
  id: columns.integer().primaryKey(),
  parent_id: columns.integer(),
  body: columns.text().notNull(),
});

export const jobs = defineTable("sisal_adv_jobs", {
  id: columns.integer().primaryKey(),
  status: columns.text().notNull(),
  priority: columns.integer().notNull(),
  locked_by: columns.text(),
  locked_at: columns.text(),
});

export const documents = defineTable("sisal_adv_documents", {
  id: columns.integer().primaryKey(),
  payload: columns.jsonb<{ title: string; items: unknown[] }>().notNull(),
});

export const backfillState = defineTable("sisal_adv_backfill_state", {
  name: columns.text().primaryKey(),
  high_watermark: columns.text().notNull(),
  updated_at: columns.text().notNull(),
});

export const schemaTables = [
  posts,
  events,
  hourlyStats,
  comments,
  jobs,
  documents,
  backfillState,
] as const;
