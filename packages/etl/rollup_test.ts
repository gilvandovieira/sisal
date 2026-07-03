/**
 * Golden-SQL tests for the generated rollup (v0.10 T13): the compiled
 * statement is pinned byte-for-byte on PostgreSQL and shape-pinned on the
 * SQLite/MySQL families — one insert-from-select with a `dateTrunc` bucket,
 * filtered aggregates, a half-open window predicate, and an upsert keyed on
 * the grain. Pure rendering; no database.
 */
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  columns,
  count,
  defineTable,
  eq,
  filter,
  OrmError,
  primaryKey,
  renderSql,
  sum,
} from "@sisal/core";
import { defineJob, explain, rollup } from "./mod.ts";

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
  votes: columns.integer().notNull(),
  score: columns.integer().notNull(),
}, (c) => [primaryKey({ columns: [c.post_id, c.bucket] })]);

const e = postEvents.columns;

const job = defineJob({
  name: "post-hourly-stats",
  source: postEvents,
  target: postHourlyStats,
  window: e.occurred_at,
  grain: "hour",
  bucket: "bucket",
  groupBy: { post_id: e.post_id },
  aggregates: {
    views: filter(count(), eq(e.kind, "view")),
    votes: filter(count(), eq(e.kind, "vote")),
    score: sum(e.score),
  },
});

const WINDOW = {
  from: "2026-01-01T00:00:00.000Z",
  until: "2026-01-01T01:00:00.000Z",
};

Deno.test("rollup: postgres render is pinned byte-for-byte", () => {
  const rendered = renderSql(rollup(job, WINDOW), { dialect: "postgres" });
  assertEquals(
    rendered.text,
    'insert into "post_hourly_stats" ' +
      '("bucket", "post_id", "views", "votes", "score") ' +
      `select date_trunc('hour', "post_events"."occurred_at") as "bucket", ` +
      '"post_events"."post_id" as "post_id", ' +
      'count(*) filter (where "post_events"."kind" = $1) as "views", ' +
      'count(*) filter (where "post_events"."kind" = $2) as "votes", ' +
      'sum("post_events"."score") as "score" ' +
      'from "post_events" ' +
      'where ("post_events"."occurred_at" >= $3) ' +
      'and ("post_events"."occurred_at" < $4) ' +
      `group by date_trunc('hour', "post_events"."occurred_at"), ` +
      '"post_events"."post_id" ' +
      'on conflict ("bucket", "post_id") do update set ' +
      '"views" = excluded."views", "votes" = excluded."votes", ' +
      '"score" = excluded."score"',
  );
  // The half-open window binds as parameters — nothing interpolates.
  assertEquals(rendered.params, ["view", "vote", WINDOW.from, WINDOW.until]);
});

Deno.test("rollup: sqlite renders strftime buckets and the same upsert", () => {
  const rendered = renderSql(rollup(job, WINDOW), { dialect: "sqlite" });
  assertStringIncludes(rendered.text, "strftime(");
  assertStringIncludes(rendered.text, "filter (where");
  assertStringIncludes(
    rendered.text,
    'on conflict ("bucket", "post_id") do update set',
  );
});

Deno.test("rollup: mysql maps the upsert to ODKU", () => {
  const rendered = renderSql(rollup(job, WINDOW), { dialect: "mysql" });
  assertStringIncludes(rendered.text, "date_format(");
  assertStringIncludes(
    rendered.text,
    "on duplicate key update `views` = values(`views`)",
  );
});

Deno.test("explain: dry-run renders the exact statement, postgres default", () => {
  const explained = explain(job, WINDOW);
  const rendered = renderSql(rollup(job, WINDOW), { dialect: "postgres" });
  assertEquals(explained.text, rendered.text);
  assertEquals(explained.params, rendered.params);
});

Deno.test("explain: renders per requested dialect", () => {
  assertStringIncludes(
    explain(job, WINDOW, { dialect: "sqlite" }).text,
    "strftime(",
  );
  assertStringIncludes(
    explain(job, WINDOW, { dialect: "mysql" }).text,
    "on duplicate key update",
  );
});

Deno.test("explain: the generic dialect fails closed, never degrades", () => {
  const error = assertThrows(
    () => explain(job, WINDOW, { dialect: "generic" }),
    OrmError,
  );
  assertEquals(error.code, "ORM_DIALECT_UNSUPPORTED");
});

Deno.test("rollup: refuses a degenerate window", () => {
  const backwards = { from: WINDOW.until, until: WINDOW.from };
  const error = assertThrows(() => rollup(job, backwards), OrmError);
  assertEquals(error.code, "ETL_INVALID_WINDOW");
  const empty = { from: WINDOW.from, until: WINDOW.from };
  assertThrows(() => rollup(job, empty), OrmError);
});
