/**
 * Capability-gating tests (v0.10 T21): `supportsJob`/`assertJobSupported`
 * answer per engine identity **before** anything executes — the canonical job
 * runs on postgres/sqlite/mysql (and the mariadb variant), the `generic`
 * dialect fails closed, and a job shape carrying an engine-specific construct
 * is a typed `ETL_UNSUPPORTED_JOB` refusal on the engines that cannot render
 * it — never a silently-degraded runner. The runner applies the gate
 * pre-flight: nothing reaches the driver for an unsupported identity.
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  columns,
  count,
  createDatabase,
  defineTable,
  dialectSql,
  eq,
  filter,
  type OrmDriver,
  OrmError,
  type OrmQueryResult,
  primaryKey,
  sql,
  type SqlQuery,
  sum,
} from "@sisal/orm";
import {
  assertJobSupported,
  defineJob,
  replay,
  run,
  supportsJob,
} from "./mod.ts";

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
}, (c) => [primaryKey({ columns: [c.post_id, c.bucket] })]);

const e = postEvents.columns;

const portable = defineJob({
  name: "post-hourly-stats",
  source: postEvents,
  target: postHourlyStats,
  window: e.occurred_at,
  grain: "hour",
  bucket: "bucket",
  groupBy: { post_id: e.post_id },
  aggregates: {
    views: filter(count(), eq(e.kind, "view")),
    score: sum(e.score),
  },
  start: "2026-01-01T00:00:00.000Z",
});

// A job whose aggregate only renders on PostgreSQL — the "unsupported job
// shape" the gate must refuse on other engines.
const pgOnly = defineJob({
  name: "pg-only-shape",
  source: postEvents,
  target: postHourlyStats,
  window: e.occurred_at,
  grain: "hour",
  bucket: "bucket",
  groupBy: { post_id: e.post_id },
  aggregates: {
    views: filter(count(), eq(e.kind, "view")),
    score: dialectSql("percentileScore (pg-only test construct)", {
      postgres: sql`percentile_cont(0.5) within group (order by ${e.score})`,
    }),
  },
  start: "2026-01-01T00:00:00.000Z",
});

Deno.test("supportsJob: the portable job runs on every ETL dialect", () => {
  for (const dialect of ["postgres", "sqlite", "mysql"] as const) {
    assertEquals(supportsJob(portable, dialect), { supported: true }, dialect);
  }
  // Full identities pass through (MariaDB behind the mysql dialect).
  assertEquals(
    supportsJob(portable, {
      dialect: "mysql",
      variant: "mariadb",
      version: "11.4.2",
    }),
    { supported: true },
  );
});

Deno.test("supportsJob: the generic dialect fails closed", () => {
  const verdict = supportsJob(portable, "generic");
  assert(!verdict.supported);
  assertStringIncludes(verdict.reason, "no ETL lock/checkpoint substrate");
});

Deno.test("supportsJob: an engine-specific shape is refused where it cannot render", () => {
  assertEquals(supportsJob(pgOnly, "postgres"), { supported: true });
  for (const dialect of ["sqlite", "mysql"] as const) {
    const verdict = supportsJob(pgOnly, dialect);
    assert(!verdict.supported, dialect);
    assertStringIncludes(verdict.reason, "percentileScore");
  }
});

Deno.test("assertJobSupported: refusal is the typed ETL_UNSUPPORTED_JOB", () => {
  const error = assertThrows(
    () => assertJobSupported(pgOnly, { dialect: "sqlite" }),
    OrmError,
  );
  assertEquals(error.code, "ETL_UNSUPPORTED_JOB");
  assertEquals(error.status, 400);
  assertEquals(error.details?.job, "pg-only-shape");
  assertEquals(error.details?.dialect, "sqlite");
  assertStringIncludes(error.message, 'ETL job "pg-only-shape"');
});

function silentDriver(): { driver: OrmDriver; executed: SqlQuery[] } {
  const executed: SqlQuery[] = [];
  const run = (query: SqlQuery): Promise<OrmQueryResult> => {
    executed.push(query);
    return Promise.resolve({ rows: [], rowCount: 0 });
  };
  return {
    driver: {
      query: <T = unknown>(q: SqlQuery) => run(q) as Promise<OrmQueryResult<T>>,
      execute: (q: SqlQuery) => run(q),
    },
    executed,
  };
}

Deno.test("run/replay: gate pre-flight — nothing reaches the driver", async () => {
  const { driver, executed } = silentDriver();
  const db = createDatabase({ driver, dialect: "sqlite" });

  for (
    const attempt of [
      () => run(db, pgOnly),
      () => replay(db, pgOnly, "2026-01-05T10:00:00Z"),
    ]
  ) {
    let code: string | undefined;
    try {
      await attempt();
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    assertEquals(code, "ETL_UNSUPPORTED_JOB");
  }
  // No lock claim, no checkpoint read, no rollup — the refusal was pre-flight.
  assertEquals(executed.length, 0);
});
