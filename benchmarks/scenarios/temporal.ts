/**
 * Date-vs-Temporal benchmarks.
 *
 * These scenarios measure raw JavaScript API costs and Sisal's own parameter
 * serialization / metadata parsing path. They intentionally avoid live database
 * roundtrips so the numbers stay focused on runtime and ORM overhead.
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
const ZONED_ISO = "2026-06-28T09:34:56.123456-03:00[America/Fortaleza]";
const FILTER_LABEL = "date api|sisal temporal";

const date = new Date(INSTANT_ISO);
const plainDate = Temporal.PlainDate.from(DATE_ISO);
const plainTime = Temporal.PlainTime.from(TIME_ISO);
const plainDateTime = Temporal.PlainDateTime.from(DATETIME_ISO);
const instant = Temporal.Instant.from(INSTANT_ISO);
const zonedDateTime = Temporal.ZonedDateTime.from(ZONED_ISO);

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

interface Reader {
  readonly run: () => Promise<readonly unknown[]> | readonly unknown[];
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

function benchName(name: string): string {
  return `${FILTER_LABEL} · ${name}`;
}

function rowsDriver(rows: readonly TemporalBenchRow[]): OrmDriver {
  return {
    query<T = unknown>(query: SqlQuery): Promise<OrmQueryResult<T>> {
      void query;
      const cloned = cloneRows(rows);
      return Promise.resolve({
        rows: cloned as T[],
        rowCount: cloned.length,
      });
    },

    execute(query: SqlQuery): Promise<OrmQueryResult> {
      void query;
      const cloned = cloneRows(rows);
      return Promise.resolve({
        rows: cloned,
        rowCount: cloned.length,
      });
    },
  };
}

function sisalReader(count: number, parse: boolean): Reader {
  const rows = makeRows(count);
  const db = createDatabase({
    dialect: "postgres",
    driver: rowsDriver(rows),
    temporal: { parse },
  });
  return {
    run: () => db.select().from(temporalRows).execute(),
  };
}

function manualDateReader(count: number): Reader {
  const rows = makeRows(count);
  return {
    run: () => rows.map((row) => new Date(row.instant_timestamp)),
  };
}

function manualTemporalReader(count: number): Reader {
  const rows = makeRows(count);
  return {
    run: () => rows.map((row) => Temporal.Instant.from(row.instant_timestamp)),
  };
}

async function readRows(reader: Reader): Promise<readonly unknown[]> {
  return await reader.run();
}

async function assertReaderCount(
  label: string,
  reader: Reader,
  count: number,
): Promise<void> {
  const rows = await readRows(reader);
  if (rows.length !== count) {
    throw new Error(`${label} returned ${rows.length} rows; expected ${count}`);
  }
}

async function assertRowReaders(): Promise<void> {
  for (const count of ROW_COUNTS) {
    await assertReaderCount(
      `parse=false ORM select (${count})`,
      sisalReader(count, false),
      count,
    );
    await assertReaderCount(
      `parse=true ORM select (${count})`,
      sisalReader(count, true),
      count,
    );
    await assertReaderCount(
      `manual Date mapping (${count})`,
      manualDateReader(count),
      count,
    );
    await assertReaderCount(
      `manual Temporal mapping (${count})`,
      manualTemporalReader(count),
      count,
    );
  }
}

await assertRowReaders();

const rowParsingScenarios: BenchmarkScenario[] = ROW_COUNTS.flatMap(
  (count) => {
    const parseDisabled = sisalReader(count, false);
    const parseEnabled = sisalReader(count, true);
    const manualDate = manualDateReader(count);
    const manualTemporal = manualTemporalReader(count);
    const group = `sisal temporal row parsing · ${count} rows`;

    return [
      {
        group,
        name: benchName(`${group} · parse=false ORM select`),
        baseline: true,
        async fn() {
          await parseDisabled.run();
        },
      },
      {
        group,
        name: benchName(`${group} · parse=true ORM select`),
        async fn() {
          await parseEnabled.run();
        },
      },
      {
        group,
        name: benchName(`${group} · manual Date map instant`),
        fn() {
          manualDate.run();
        },
      },
      {
        group,
        name: benchName(`${group} · manual Temporal map instant`),
        fn() {
          manualTemporal.run();
        },
      },
    ];
  },
);

export const temporalScenarios: readonly BenchmarkScenario[] = [
  {
    group: "date api parse",
    name: benchName("date api parse · new Date(INSTANT_ISO)"),
    baseline: true,
    fn() {
      new Date(INSTANT_ISO);
    },
  },
  {
    group: "date api parse",
    name: benchName("date api parse · Temporal.Instant.from(INSTANT_ISO)"),
    fn() {
      Temporal.Instant.from(INSTANT_ISO);
    },
  },
  {
    group: "date api parse",
    name: benchName("date api parse · Temporal.PlainDate.from(DATE_ISO)"),
    fn() {
      Temporal.PlainDate.from(DATE_ISO);
    },
  },
  {
    group: "date api parse",
    name: benchName("date api parse · Temporal.PlainTime.from(TIME_ISO)"),
    fn() {
      Temporal.PlainTime.from(TIME_ISO);
    },
  },
  {
    group: "date api parse",
    name: benchName(
      "date api parse · Temporal.PlainDateTime.from(DATETIME_ISO)",
    ),
    fn() {
      Temporal.PlainDateTime.from(DATETIME_ISO);
    },
  },
  {
    group: "date api parse",
    name: benchName(
      "date api parse · Temporal.ZonedDateTime.from(ZONED_ISO)",
    ),
    fn() {
      Temporal.ZonedDateTime.from(ZONED_ISO);
    },
  },

  {
    group: "date api format",
    name: benchName("date api format · date.toISOString()"),
    baseline: true,
    fn() {
      date.toISOString();
    },
  },
  {
    group: "date api format",
    name: benchName("date api format · instant.toString()"),
    fn() {
      instant.toString();
    },
  },
  {
    group: "date api format",
    name: benchName("date api format · plainDate.toString()"),
    fn() {
      plainDate.toString();
    },
  },
  {
    group: "date api format",
    name: benchName("date api format · plainTime.toString()"),
    fn() {
      plainTime.toString();
    },
  },
  {
    group: "date api format",
    name: benchName("date api format · plainDateTime.toString()"),
    fn() {
      plainDateTime.toString();
    },
  },
  {
    group: "date api format",
    name: benchName(
      "date api format · zonedDateTime.toInstant().toString()",
    ),
    fn() {
      zonedDateTime.toInstant().toString();
    },
  },

  {
    group: "sisal temporal params",
    name: benchName("sisal temporal params · serializeSqlValue(date)"),
    baseline: true,
    fn() {
      serializeSqlValue(date);
    },
  },
  {
    group: "sisal temporal params",
    name: benchName(
      "sisal temporal params · serializeSqlValue(Temporal.Instant)",
    ),
    fn() {
      serializeSqlValue(instant);
    },
  },
  {
    group: "sisal temporal params",
    name: benchName(
      "sisal temporal params · serializeSqlValue(Temporal.PlainDate)",
    ),
    fn() {
      serializeSqlValue(plainDate);
    },
  },
  {
    group: "sisal temporal params",
    name: benchName(
      "sisal temporal params · serializeSqlValue(Temporal.PlainTime)",
    ),
    fn() {
      serializeSqlValue(plainTime);
    },
  },
  {
    group: "sisal temporal params",
    name: benchName(
      "sisal temporal params · serializeSqlValue(Temporal.PlainDateTime)",
    ),
    fn() {
      serializeSqlValue(plainDateTime);
    },
  },
  {
    group: "sisal temporal params",
    name: benchName(
      "sisal temporal params · serializeSqlValue(Temporal array)",
    ),
    fn() {
      serializeSqlValue([plainDate, instant]);
    },
  },
  {
    group: "sisal temporal params",
    name: benchName("sisal temporal params · render sql Date param"),
    fn() {
      renderSql(sql`select ${date}`, { dialect: "postgres" });
    },
  },
  {
    group: "sisal temporal params",
    name: benchName(
      "sisal temporal params · render sql Temporal.Instant param",
    ),
    fn() {
      renderSql(sql`select ${instant}`, { dialect: "postgres" });
    },
  },
  {
    group: "sisal temporal params",
    name: benchName(
      "sisal temporal params · render mixed Temporal statement",
    ),
    fn() {
      renderSql(
        sql`select ${plainDate}, ${plainTime}, ${plainDateTime}, ${instant}`,
        { dialect: "postgres" },
      );
    },
  },

  ...rowParsingScenarios,
];
