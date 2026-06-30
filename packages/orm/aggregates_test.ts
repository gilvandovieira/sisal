/**
 * Conditional aggregates and portable date math (v0.5.0 roadmap item 9):
 * `filter(agg, cond)` renders a native `FILTER (WHERE …)` clause on every
 * adapter, and `dateTrunc(field, src)` renders `date_trunc` on PostgreSQL and
 * the equivalent `strftime` on the SQLite family. `dialectSql` is the
 * per-dialect rendering primitive behind `dateTrunc`.
 *
 * @module
 */
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  columns,
  dateTrunc,
  defineTable,
  dialectSql,
  eq,
  filter,
  OrmError,
  raw,
  renderSql,
  sql,
  sum,
} from "./mod.ts";

const events = defineTable("events", {
  id: columns.integer().primaryKey(),
  score: columns.integer(),
  kind: columns.text(),
  at: columns.timestamp(),
});

Deno.test("filter: renders a native FILTER (WHERE …) clause per dialect", () => {
  const expr = filter(sum(events.columns.score), eq(events.columns.kind, "x"));

  const pg = renderSql(expr, { dialect: "postgres" });
  assertEquals(
    pg.text,
    'sum("events"."score") filter (where "events"."kind" = $1)',
  );
  assertEquals(pg.params, ["x"]);

  const lite = renderSql(expr, { dialect: "sqlite" });
  assertEquals(
    lite.text,
    'sum("events"."score") filter (where "events"."kind" = ?)',
  );
  assertEquals(lite.params, ["x"]);
});

Deno.test("filter: rejects a non-condition second argument", () => {
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => filter(sum(events.columns.score), "not a condition" as any),
    OrmError,
  );
});

Deno.test("dateTrunc: renders date_trunc on Postgres, strftime on SQLite", () => {
  const minute = dateTrunc("minute", events.columns.at);
  assertEquals(
    renderSql(minute, { dialect: "postgres" }).text,
    `date_trunc('minute', "events"."at")`,
  );
  assertEquals(
    renderSql(minute, { dialect: "sqlite" }).text,
    `strftime('%Y-%m-%d %H:%M:00', "events"."at")`,
  );

  // Each calendar field maps to its own Postgres unit / SQLite format.
  assertEquals(
    renderSql(dateTrunc("day", events.columns.at), { dialect: "postgres" })
      .text,
    `date_trunc('day', "events"."at")`,
  );
  assertEquals(
    renderSql(dateTrunc("month", events.columns.at), { dialect: "sqlite" })
      .text,
    `strftime('%Y-%m-01 00:00:00', "events"."at")`,
  );
});

Deno.test("dateTrunc: accepts an arbitrary SQL expression as source", () => {
  const expr = dateTrunc(
    "hour",
    sql`${events.columns.at} + ${raw("interval")}`,
  );
  assertStringIncludes(
    renderSql(expr, { dialect: "postgres" }).text,
    `date_trunc('hour', "events"."at" + interval)`,
  );
});

Deno.test("dateTrunc: throws on an unknown field at runtime", () => {
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => dateTrunc("decade" as any, events.columns.at),
    OrmError,
    "dateTrunc field",
  );
});

Deno.test("dialectSql: picks the active dialect's variant", () => {
  const expr = dialectSql("demo", {
    postgres: sql`now()`,
    sqlite: sql`datetime('now')`,
  });
  assertEquals(renderSql(expr, { dialect: "postgres" }).text, "now()");
  assertEquals(renderSql(expr, { dialect: "sqlite" }).text, "datetime('now')");
});

Deno.test("dialectSql: falls back when the dialect has no variant", () => {
  const expr = dialectSql("demo", { postgres: sql`now()` }, sql`current_time`);
  assertEquals(renderSql(expr, { dialect: "sqlite" }).text, "current_time");
});

Deno.test("dialectSql: throws when no variant and no fallback match", () => {
  const expr = dialectSql("demo", { postgres: sql`now()` });
  const error = assertThrows(
    () => renderSql(expr, { dialect: "sqlite" }),
    OrmError,
    "demo",
  );
  assertEquals((error as OrmError).code, "ORM_DIALECT_UNSUPPORTED");
  assertStringIncludes((error as Error).message, "sqlite");
});
