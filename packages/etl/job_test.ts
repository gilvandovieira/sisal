/**
 * Definition-time validation tests for `defineJob` (v0.10 T12): a job that
 * would generate un-runnable SQL must refuse to construct, with the typed
 * `ETL_INVALID_JOB` error naming the defect — unknown grain, foreign window
 * column, non-target projection keys, double-claimed columns, missing
 * aggregates, uncovered insert-required target columns, and an unaligned or
 * unparsable start.
 */
import { assertEquals, assertThrows } from "@std/assert";
import {
  columns,
  count,
  defineTable,
  eq,
  filter,
  OrmError,
  primaryKey,
  sum,
} from "@sisal/core";
import { defineJob } from "./mod.ts";

const postEvents = defineTable("post_events", {
  id: columns.bigserial().primaryKey(),
  post_id: columns.bigint().notNull(),
  kind: columns.text().notNull(),
  score: columns.integer().notNull(),
  occurred_at: columns.timestamp({ withTimezone: true, mode: "date" })
    .notNull(),
});

const postHourlyStats = defineTable("post_hourly_stats", {
  post_id: columns.bigint().notNull(),
  bucket: columns.timestamp({ withTimezone: true, mode: "date" }).notNull(),
  views: columns.integer().notNull(),
  score: columns.integer().notNull(),
  note: columns.text().optional(),
}, (c) => [primaryKey({ columns: [c.post_id, c.bucket] })]);

const e = postEvents.columns;

function baseConfig() {
  return {
    name: "post-hourly-stats",
    source: postEvents,
    target: postHourlyStats,
    window: e.occurred_at,
    grain: "hour" as const,
    bucket: "bucket" as const,
    groupBy: { post_id: e.post_id },
    aggregates: {
      views: filter(count(), eq(e.kind, "view")),
      score: sum(e.score),
    },
  };
}

function assertInvalidJob(
  config: Parameters<typeof defineJob>[0],
  messageIncludes: string,
): void {
  const error = assertThrows(() => defineJob(config), OrmError);
  assertEquals(error.code, "ETL_INVALID_JOB");
  assertEquals(error.message.includes(messageIncludes), true, error.message);
}

Deno.test("defineJob: a valid job normalizes and freezes", () => {
  const job = defineJob({ ...baseConfig(), start: "2026-01-01T05:00:00Z" });
  assertEquals(job.kind, "etl-job");
  assertEquals(job.name, "post-hourly-stats");
  assertEquals(Object.keys(job.groupBy), ["post_id"]);
  assertEquals(Object.keys(job.aggregates), ["views", "score"]);
  // The start is normalized to a full ISO instant.
  assertEquals(job.start, "2026-01-01T05:00:00.000Z");
  assertEquals(Object.isFrozen(job), true);
});

Deno.test("defineJob: refuses an empty or oversized name", () => {
  assertInvalidJob({ ...baseConfig(), name: "  " }, "name is required");
  assertInvalidJob(
    { ...baseConfig(), name: "x".repeat(201) },
    "at most 200",
  );
});

Deno.test("defineJob: refuses an unknown grain", () => {
  assertInvalidJob(
    { ...baseConfig(), grain: "week" as unknown as "hour" },
    'Unknown ETL grain "week"',
  );
});

Deno.test("defineJob: refuses a window column from another table", () => {
  assertInvalidJob(
    { ...baseConfig(), window: postHourlyStats.columns.bucket },
    "window column must be a column of the source table",
  );
});

Deno.test("defineJob: refuses projection keys that are not target columns", () => {
  assertInvalidJob(
    { ...baseConfig(), bucket: "no_such" as "bucket" },
    'bucket key "no_such" is not a column of the target table',
  );
  assertInvalidJob(
    {
      ...baseConfig(),
      groupBy: { nope: e.post_id } as unknown as { post_id: typeof e.post_id },
    },
    'groupBy key "nope" is not a column',
  );
});

Deno.test("defineJob: refuses a double-claimed target column", () => {
  assertInvalidJob(
    {
      ...baseConfig(),
      aggregates: { ...baseConfig().aggregates, post_id: count() },
    },
    'target column "post_id" is claimed twice',
  );
});

Deno.test("defineJob: refuses an empty aggregate set and non-Sql aggregates", () => {
  assertInvalidJob(
    { ...baseConfig(), aggregates: {} },
    "at least one aggregate",
  );
  assertInvalidJob(
    {
      ...baseConfig(),
      aggregates: { views: 42 as unknown as ReturnType<typeof count> },
    },
    'aggregate "views" must be a Sql expression',
  );
});

Deno.test("defineJob: refuses uncovered insert-required target columns", () => {
  // `score` (not-null, no default) is left unclaimed; `note` is `.optional()`
  // and stays exempt.
  assertInvalidJob(
    {
      ...baseConfig(),
      aggregates: { views: filter(count(), eq(e.kind, "view")) },
    },
    'uncovered: "score"',
  );
});

Deno.test("defineJob: refuses an unparsable or grain-unaligned start", () => {
  assertInvalidJob(
    { ...baseConfig(), start: "not-a-date" },
    "must be an ISO-8601 instant",
  );
  assertInvalidJob(
    { ...baseConfig(), start: "2026-01-01T05:30:00Z" },
    'must lie on a "hour" edge',
  );
});
