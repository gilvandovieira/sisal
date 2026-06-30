/**
 * Conditional aggregates and portable date math (v0.5.0 roadmap item 9):
 * `filter(agg, cond)` renders a native `FILTER (WHERE …)` clause on every
 * adapter; `dateTrunc` truncates to a calendar field; `now`/`dateAdd`/`dateSub`
 * do `now()`-relative interval arithmetic; and `dateBin` floors to an
 * arbitrary-width bucket — each rendering its own per-dialect SQL. `dialectSql`
 * is the per-dialect rendering primitive behind them.
 *
 * @module
 */
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  columns,
  dateAdd,
  dateBin,
  dateSub,
  dateTrunc,
  defineTable,
  dialectSql,
  eq,
  filter,
  now,
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

Deno.test("now: renders the per-dialect current timestamp", () => {
  assertEquals(renderSql(now(), { dialect: "postgres" }).text, "now()");
  assertEquals(renderSql(now(), { dialect: "sqlite" }).text, "datetime('now')");
});

Deno.test("dateSub / dateAdd: interval arithmetic per dialect", () => {
  // PostgreSQL binds one compound interval literal and casts it.
  const pg = renderSql(dateSub(now(), { minutes: 15 }), {
    dialect: "postgres",
  });
  assertEquals(pg.text, "now() - $1::interval");
  assertEquals(pg.params, ["15 minutes"]);

  // The SQLite family chains one signed datetime() modifier per unit.
  const lite = renderSql(dateSub(now(), { minutes: 15 }), {
    dialect: "sqlite",
  });
  assertEquals(lite.text, "datetime(datetime('now'), ?)");
  assertEquals(lite.params, ["-15 minutes"]);

  const add = renderSql(
    dateAdd(events.columns.at, { hours: 1, minutes: 30 }),
    { dialect: "postgres" },
  );
  assertEquals(add.text, `"events"."at" + $1::interval`);
  assertEquals(add.params, ["1 hours 30 minutes"]);

  const addLite = renderSql(
    dateAdd(events.columns.at, { hours: 1, minutes: 30 }),
    { dialect: "sqlite" },
  );
  assertEquals(addLite.text, `datetime("events"."at", ?, ?)`);
  assertEquals(addLite.params, ["+1 hours", "+30 minutes"]);
});

Deno.test("dateSub: rejects an empty or non-finite duration", () => {
  assertThrows(() => dateSub(now(), {}), OrmError, "non-zero");
  assertThrows(
    () => dateSub(now(), { minutes: Number.NaN }),
    OrmError,
    "minutes",
  );
});

Deno.test("dateBin: floors to an N-second bucket per dialect", () => {
  const bin = dateBin({ minutes: 5 }, events.columns.at);
  assertEquals(
    renderSql(bin, { dialect: "postgres" }).text,
    `to_timestamp(floor(extract(epoch from "events"."at") / 300) * 300)`,
  );
  assertEquals(
    renderSql(bin, { dialect: "sqlite" }).text,
    `datetime((unixepoch("events"."at") / 300) * 300, 'unixepoch')`,
  );

  // Compound fixed-width units sum to seconds (1h30m → 5400).
  assertStringIncludes(
    renderSql(dateBin({ hours: 1, minutes: 30 }, events.columns.at), {
      dialect: "postgres",
    }).text,
    "/ 5400) * 5400",
  );
});

Deno.test("dateBin: rejects calendar units and non-positive intervals", () => {
  assertThrows(
    () => dateBin({ months: 1 }, events.columns.at),
    OrmError,
    "months",
  );
  assertThrows(() => dateBin({ seconds: 0 }, events.columns.at), OrmError);
});
