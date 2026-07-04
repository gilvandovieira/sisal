/**
 * Analytics capability-gating tests (v0.11 T12): supported windowed analytics
 * render on the engines whose core window grammar accepts them; Postgres-first
 * percentiles fail closed elsewhere with analytics' typed preflight error.
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  columns,
  countDistinct,
  defineTable,
  OrmError,
  sum,
} from "@sisal/core";
import {
  assertQuerySupported,
  bucket,
  from,
  movingAvg,
  percentileDisc,
  supportsQuery,
} from "./mod.ts";

const dailyStats = defineTable("daily_stats", {
  accountId: columns.bigint().notNull(),
  bucket: columns.timestamp({ withTimezone: true, mode: "date" }).notNull(),
  views: columns.integer().notNull(),
  actorId: columns.bigint().notNull(),
});

const s = dailyStats.columns;

const portableWindowQuery = from(dailyStats)
  .dimensions({
    accountId: s.accountId,
    day: bucket("day", s.bucket),
  })
  .metrics({
    views: sum(s.views),
    actors: countDistinct(s.actorId),
  })
  .windows({
    views7d: movingAvg("views", {
      partitionBy: ["accountId"],
      orderBy: ["day"],
      rows: 7,
    }),
  });

Deno.test("capability: basic analytics window renders on all SQL families", () => {
  for (const dialect of ["postgres", "sqlite", "mysql"] as const) {
    assertEquals(supportsQuery(portableWindowQuery, { dialect }), {
      supported: true,
    });
  }

  assertStringIncludes(
    portableWindowQuery.render({ dialect: "postgres" }).text,
    "to_char(date_trunc('day'",
  );
  assertStringIncludes(
    portableWindowQuery.render({ dialect: "postgres" }).text,
    "rows between 6 preceding and current row",
  );
  assertStringIncludes(
    portableWindowQuery.render({ dialect: "sqlite" }).text,
    "strftime(",
  );
  assertStringIncludes(
    portableWindowQuery.render({ dialect: "mysql" }).text,
    "date_format(",
  );
});

Deno.test("capability: percentiles are Postgres-first typed failures elsewhere", () => {
  const query = from(dailyStats)
    .dimensions({ day: bucket("day", s.bucket) })
    .metrics({
      medianAccount: percentileDisc<string>(0.5, s.accountId),
    });

  assertEquals(supportsQuery(query, { dialect: "postgres" }), {
    supported: true,
  });

  for (
    const identity of [
      { dialect: "sqlite" as const },
      { dialect: "mysql" as const },
      { dialect: "mysql" as const, variant: "mariadb", version: "11.8.8" },
    ]
  ) {
    const support = supportsQuery(query, identity);
    assertEquals(support.supported, false);
    if (!support.supported) {
      assertStringIncludes(support.reason, "percentile_cont/percentile_disc");
    }

    const error = assertThrows(
      () => assertQuerySupported(query, identity),
      OrmError,
    );
    assertEquals(error.code, "ANALYTICS_UNSUPPORTED_QUERY");
    assert(error.message.includes(identity.dialect));
  }
});
