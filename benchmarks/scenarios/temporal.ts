/**
 * Sisal temporal serialization + parsing benchmarks.
 *
 * These scenarios isolate Sisal's *own* temporal work — nothing here measures
 * the raw `Date`/`Temporal` runtime APIs, which Sisal cannot influence. Two
 * paths are covered, both database-free:
 *
 *  - "sisal temporal params"          — `serializeSqlValue(...)` and `renderSql`
 *    turning `Date`/`Temporal.*` values into bound parameters (the write side).
 *  - "sisal temporal row parsing · N" — a fake `OrmDriver` returns rows shaped
 *    like database date/time text, swept across 1 / 100 / 1000 rows. `parse=false`
 *    is the baseline; `parse=true` adds Temporal decoding, so the ratio is the
 *    per-row cost Sisal pays to hand back `Temporal.*` values instead of strings.
 *
 * @module
 */

import {
  columns,
  createDatabase,
  defineTable,
  type OrmDriver,
  type OrmQueryResult,
  renderSql,
  serializeSqlValue,
  sql,
  type SqlQuery,
} from "@sisal/orm";

import type { BenchmarkScenario } from "../harness.ts";

const DATE_ISO = "2026-06-28";
const TIME_ISO = "12:34:56.123456";
const DATETIME_ISO = "2026-06-28T12:34:56.123456";
const INSTANT_ISO = "2026-06-28T12:34:56.123456Z";

const date = new Date(INSTANT_ISO);
const plainDate = Temporal.PlainDate.from(DATE_ISO);
const plainTime = Temporal.PlainTime.from(TIME_ISO);
const plainDateTime = Temporal.PlainDateTime.from(DATETIME_ISO);
const instant = Temporal.Instant.from(INSTANT_ISO);

const temporalRows = defineTable("bench_temporal_rows", {
  id: columns.integer().primaryKey(),
  plain_date: columns.date(),
  plain_time: columns.time(),
  plain_timestamp: columns.timestamp(),
  instant_timestamp: columns.timestamp({ withTimezone: true }),
});

interface TemporalBenchRow {
  readonly id: number;
  readonly plain_date: string;
  readonly plain_time: string;
  readonly plain_timestamp: string;
  readonly instant_timestamp: string;
}

const ROW_COUNTS = [1, 100, 1000] as const;

function makeRows(count: number): TemporalBenchRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    plain_date: DATE_ISO,
    plain_time: TIME_ISO,
    plain_timestamp: DATETIME_ISO,
    instant_timestamp: INSTANT_ISO,
  }));
}

function cloneRows(rows: readonly TemporalBenchRow[]): TemporalBenchRow[] {
  return rows.map((row) => ({ ...row }));
}

function rowsDriver(rows: readonly TemporalBenchRow[]): OrmDriver {
  return {
    query<T = unknown>(query: SqlQuery): Promise<OrmQueryResult<T>> {
      void query;
      const cloned = cloneRows(rows);
      return Promise.resolve({ rows: cloned as T[], rowCount: cloned.length });
    },

    execute(query: SqlQuery): Promise<OrmQueryResult> {
      void query;
      const cloned = cloneRows(rows);
      return Promise.resolve({ rows: cloned, rowCount: cloned.length });
    },
  };
}

function sisalSelect(count: number, parse: boolean): () => Promise<unknown[]> {
  const rows = makeRows(count);
  const db = createDatabase({
    dialect: "postgres",
    driver: rowsDriver(rows),
    temporal: { parse },
  });
  return () => db.select().from(temporalRows).execute();
}

// Fail fast if the fake read path stops returning the expected row counts.
for (const count of ROW_COUNTS) {
  for (const parse of [false, true] as const) {
    const rows = await sisalSelect(count, parse)();
    if (rows.length !== count) {
      throw new Error(
        `parse=${parse} ORM select returned ${rows.length}; expected ${count}`,
      );
    }
  }
}

const rowParsingScenarios: BenchmarkScenario[] = ROW_COUNTS.flatMap((count) => {
  const parseDisabled = sisalSelect(count, false);
  const parseEnabled = sisalSelect(count, true);
  const group = `sisal temporal row parsing · ${count} rows`;

  return [
    {
      group,
      name: `${group} · parse=false ORM select`,
      baseline: true,
      async fn() {
        await parseDisabled();
      },
    },
    {
      group,
      name: `${group} · parse=true ORM select`,
      async fn() {
        await parseEnabled();
      },
    },
  ];
});

export const temporalScenarios: readonly BenchmarkScenario[] = [
  {
    group: "sisal temporal params",
    name: "serializeSqlValue(Date)",
    baseline: true,
    fn() {
      serializeSqlValue(date);
    },
  },
  {
    group: "sisal temporal params",
    name: "serializeSqlValue(Temporal.Instant)",
    fn() {
      serializeSqlValue(instant);
    },
  },
  {
    group: "sisal temporal params",
    name: "serializeSqlValue(Temporal.PlainDate)",
    fn() {
      serializeSqlValue(plainDate);
    },
  },
  {
    group: "sisal temporal params",
    name: "serializeSqlValue(Temporal.PlainTime)",
    fn() {
      serializeSqlValue(plainTime);
    },
  },
  {
    group: "sisal temporal params",
    name: "serializeSqlValue(Temporal.PlainDateTime)",
    fn() {
      serializeSqlValue(plainDateTime);
    },
  },
  {
    group: "sisal temporal params",
    name: "serializeSqlValue(Temporal array)",
    fn() {
      serializeSqlValue([plainDate, instant]);
    },
  },
  {
    group: "sisal temporal params",
    name: "render sql Date param",
    fn() {
      renderSql(sql`select ${date}`, { dialect: "postgres" });
    },
  },
  {
    group: "sisal temporal params",
    name: "render sql Temporal.Instant param",
    fn() {
      renderSql(sql`select ${instant}`, { dialect: "postgres" });
    },
  },
  {
    group: "sisal temporal params",
    name: "render mixed Temporal statement",
    fn() {
      renderSql(
        sql`select ${plainDate}, ${plainTime}, ${plainDateTime}, ${instant}`,
        { dialect: "postgres" },
      );
    },
  },

  ...rowParsingScenarios,
];
