import { columns, defineTable, index, primaryKey, sql } from "@sisal/orm";

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

/**
 * Documents for the JSON-extraction (10) and generated-column (11) contracts.
 * `title_text` is a stored generated column and the table carries a partial
 * expression index — both now expressible in the schema snapshot, so the
 * contract-11 DDL is emitted by the PostgreSQL generator rather than hand-rolled.
 * Kept out of {@link schemaTables} because contract 11 emits its DDL separately.
 */
export const documents = defineTable("sisal_adv_documents", {
  id: columns.integer().primaryKey(),
  payload: columns.jsonb().notNull(),
  title_text: columns.text().generatedAs(sql`payload ->> 'title'`, {
    stored: true,
  }),
}, () => [
  index("sisal_adv_documents_title_idx")
    .where(sql`title_text is not null`)
    .on(sql`lower(title_text)`),
]);

export const schemaTables = [
  posts,
  events,
  hourlyStats,
  comments,
  jobs,
  backfillState,
] as const;
