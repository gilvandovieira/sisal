/**
 * Wave-3 expression surface (v0.8 items 7/9/10): `expr`, `coalesce`,
 * `greatest`/`least`, `dateDiff`, and the window primitives — per-dialect
 * renders, validation, and the GROUPS-frame capability gate.
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  avg,
  coalesce,
  columns,
  dateDiff,
  defineTable,
  denseRank,
  expr,
  greatest,
  lag,
  lead,
  least,
  OrmError,
  over,
  rank,
  renderSql,
  rowNumber,
  sql,
} from "../mod.ts";
import type { DialectIdentity, Sql } from "../mod.ts";

const stats = defineTable("post_hourly_stats", {
  postId: columns.integer().notNull(),
  bucket: columns.timestamp().notNull(),
  votes: columns.integer().notNull(),
});
const s = stats.columns;

function pg(fragment: Sql) {
  return renderSql(fragment, { dialect: "postgres" });
}

Deno.test("expr: types a fragment without changing its render", () => {
  const doubled = expr<number>(sql`${s.votes} * 2`);
  const rendered = pg(sql`select ${doubled}`);
  assertEquals(rendered.text, 'select "post_hourly_stats"."votes" * 2');
});

Deno.test("coalesce: columns render, literals bind, all dialects", () => {
  const fragment = coalesce<number>(s.votes, 0);
  assertEquals(
    pg(fragment).text,
    'coalesce("post_hourly_stats"."votes", $1)',
  );
  assertEquals(pg(fragment).params, [0]);
  assertEquals(
    renderSql(fragment, { dialect: "mysql" }).text,
    "coalesce(`post_hourly_stats`.`votes`, ?)",
  );
  const error = assertThrows(() => coalesce(s.votes), OrmError);
  assertEquals(error.code, "ORM_INVALID_QUERY");
});

Deno.test("greatest/least: native on pg/mysql, scalar max/min on sqlite", () => {
  const capped = greatest<number>(s.votes, 0);
  assertEquals(pg(capped).text, 'greatest("post_hourly_stats"."votes", $1)');
  assertEquals(
    renderSql(capped, { dialect: "mysql" }).text,
    "greatest(`post_hourly_stats`.`votes`, ?)",
  );
  assertEquals(
    renderSql(capped, { dialect: "sqlite" }).text,
    'max("post_hourly_stats"."votes", ?)',
  );
  assertEquals(
    renderSql(least<number>(s.votes, 100), { dialect: "sqlite" }).text,
    'min("post_hourly_stats"."votes", ?)',
  );
});

Deno.test("dateDiff: truncated whole units per dialect", () => {
  const gap = dateDiff("minutes", lag(s.bucket), s.bucket);
  const wrapped = over(gap, { orderBy: [s.bucket] });
  // The composed sessionization gap: lag() inside dateDiff inside over().
  assert(pg(wrapped).text.includes("over ("));

  const minutes = dateDiff("minutes", s.bucket, sql`now()`);
  assertEquals(
    pg(minutes).text,
    'trunc(extract(epoch from (now() - "post_hourly_stats"."bucket")) / 60)',
  );
  assertEquals(
    renderSql(minutes, { dialect: "mysql" }).text,
    "timestampdiff(minute, `post_hourly_stats`.`bucket`, now())",
  );
  assertEquals(
    renderSql(minutes, { dialect: "sqlite" }).text,
    'cast((julianday(now()) - julianday("post_hourly_stats"."bucket")) ' +
      "* 86400.0 / 60 as integer)",
  );
  // No generic variant — fails typed like the other date helpers.
  const error = assertThrows(
    () => renderSql(minutes, { dialect: "generic" }),
    OrmError,
    "dateDiff",
  );
  assertEquals(error.code, "ORM_DIALECT_UNSUPPORTED");
});

Deno.test("over: partition + order + rows frame renders portably", () => {
  const moving = over(avg(s.votes), {
    partitionBy: [s.postId],
    orderBy: [s.bucket],
    frame: { unit: "rows", start: { preceding: 5 }, end: "currentRow" },
  });
  assertEquals(
    pg(moving).text,
    'avg("post_hourly_stats"."votes") over (' +
      'partition by "post_hourly_stats"."post_id" ' +
      'order by "post_hourly_stats"."bucket" ' +
      "rows between 5 preceding and current row)",
  );
  // Same shape with backticks under mysql — windows are unguarded at the
  // supported version floors.
  assert(
    renderSql(moving, { dialect: "mysql" }).text.includes(
      "rows between 5 preceding and current row",
    ),
  );
});

Deno.test("over: empty spec and ranking/offset functions", () => {
  assertEquals(pg(over(rank())).text, "rank() over ()");
  assertEquals(pg(denseRank()).text, "dense_rank()");
  assertEquals(pg(rowNumber()).text, "row_number()");
  assertEquals(
    pg(lag<number>(s.votes, 2, 0)).text,
    'lag("post_hourly_stats"."votes", 2, $1)',
  );
  assertEquals(
    pg(lead<number>(s.votes)).text,
    'lead("post_hourly_stats"."votes", 1)',
  );
  const error = assertThrows(() => lag(s.votes, -1), OrmError);
  assertEquals(error.code, "ORM_INVALID_SQL");
  const frameError = assertThrows(
    () =>
      pg(over(rank(), {
        frame: { unit: "rows", start: { preceding: 1.5 }, end: "currentRow" },
      })),
    OrmError,
  );
  assertEquals(frameError.code, "ORM_INVALID_SQL");
});

Deno.test("lag/lead: the default argument is guarded on MariaDB", () => {
  const mariadb: DialectIdentity = {
    dialect: "mysql",
    variant: "mariadb",
    version: "11.8.8",
  };
  const withDefault = over(lag<number>(s.votes, 1, 0), { orderBy: [s.bucket] });
  const error = assertThrows(
    () => renderSql(withDefault, mariadb),
    OrmError,
    "lag()/lead() default argument",
  );
  assertEquals((error as OrmError).code, "ORM_DIALECT_UNSUPPORTED");
  // Two-argument lag renders on MariaDB; the portable default spelling is
  // coalesce around the windowed expression.
  const portable = coalesce<number>(
    over(lag<number>(s.votes), { orderBy: [s.bucket] }),
    0,
  );
  assert(renderSql(portable, mariadb).text.startsWith("coalesce(lag("));
  // MySQL proper accepts the native default argument.
  assert(
    renderSql(withDefault, { dialect: "mysql" }).text.includes("lag("),
  );
});

Deno.test("over: GROUPS frames are capability-gated fail-closed", () => {
  const grouped = over(avg(s.votes), {
    orderBy: [s.bucket],
    frame: { unit: "groups", start: "unboundedPreceding", end: "currentRow" },
  });
  // PostgreSQL renders GROUPS natively.
  assert(pg(grouped).text.includes("groups between"));
  // Bare sqlite (unknown version) stays guarded — fail closed …
  const sqliteError = assertThrows(
    () => renderSql(grouped, { dialect: "sqlite" }),
    OrmError,
    "GROUPS window frames",
  );
  assertEquals(sqliteError.code, "ORM_DIALECT_UNSUPPORTED");
  // … while a detected SQLite >= 3.28 identity lights it.
  const sqlite345: DialectIdentity = { dialect: "sqlite", version: "3.45.1" };
  assert(renderSql(grouped, sqlite345).text.includes("groups between"));
  // The MySQL family has no GROUPS unit at any version.
  const mariadb: DialectIdentity = {
    dialect: "mysql",
    variant: "mariadb",
    version: "11.8.8",
  };
  const mysqlError = assertThrows(
    () => renderSql(grouped, mariadb),
    OrmError,
    "GROUPS window frames",
  );
  assertEquals(mysqlError.code, "ORM_DIALECT_UNSUPPORTED");
});
