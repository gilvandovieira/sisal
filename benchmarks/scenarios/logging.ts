/**
 * ORM logging-verbosity benchmarks.
 *
 * These isolate the cost the *logging layer* adds to the ORM query hot path —
 * building the log record, resolving level/category, redacting bind parameters,
 * and dispatching to the logger — with everything else held constant. The
 * database is the zero-latency fake driver and the logger is a no-op, so the
 * numbers reflect Sisal's own per-query logging overhead, not TCP, the engine,
 * or how fast a real `console`/file sink is (that cost belongs to the sink).
 *
 * Two groups, each with the logging-off facade as the baseline so `deno bench`
 * prints the overhead directly:
 *  - "orm logging verbosity"       — one 5-parameter query across off / error /
 *    info / debug / trace / trace-without-params. This is the everyday shape.
 *  - "orm logging redaction cost"  — a 64-parameter query at trace, isolating
 *    the `redactSqlParameters` cost that scales with the bind count.
 *
 * The "off" facade is the default `createDatabase(...)` with no logging options,
 * i.e. the production path when nobody opts in. If that column is not ~1.0×,
 * the logging layer taxes every query whether or not anyone is listening.
 *
 * @module
 */

import {
  and,
  columns,
  type Condition,
  createDatabase,
  defineTable,
  eq,
  type Logger,
  type SisalLoggingOptions,
  type Sql,
} from "@sisal/orm";

import { createFakeDbProxy } from "../fakedbproxy.ts";
import type { BenchmarkScenario } from "../harness.ts";

const noop = () => {};
const noopLogger: Logger = {
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
};

const users = defineTable("users", {
  id: columns.integer().primaryKey(),
  org: columns.integer(),
  status: columns.text(),
  score: columns.integer(),
  tag: columns.text(),
});

// One shared zero-latency driver returning a single row, so the result-decode
// path runs identically for every facade — only the logging config differs.
const proxy = createFakeDbProxy({ rows: 1 });
const driver = proxy.asOrmDriver();

function makeDb(logging?: SisalLoggingOptions) {
  return createDatabase({
    dialect: "postgres",
    driver,
    ...(logging === undefined ? {} : { logging }),
  });
}

// A builder db used only to pre-render the benchmark queries once, up front.
const scratch = makeDb();

// Cycles the five columns so a query of any width binds mixed value types
// (numbers, strings) — the shapes `redactSqlParameters` has to summarize.
const conditionCycle: Array<() => Condition> = [
  () => eq(users.columns.id, 1),
  () => eq(users.columns.org, 2),
  () => eq(users.columns.status, "active"),
  () => eq(users.columns.score, 5),
  () => eq(users.columns.tag, "x"),
];

function buildQuery(paramCount: number): Sql {
  const conditions = Array.from(
    { length: paramCount },
    (_, index) => conditionCycle[index % conditionCycle.length](),
  );
  const where = conditions.length === 1 ? conditions[0] : and(...conditions);
  return scratch.select().from(users).where(where).toSql();
}

const typicalQuery = buildQuery(5);
const wideQuery = buildQuery(64);

const dbOff = makeDb();
const dbError = makeDb({ logger: noopLogger, level: "error" });
const dbInfo = makeDb({ logger: noopLogger, level: "info" });
const dbDebug = makeDb({ logger: noopLogger, level: "debug" });
const dbTrace = makeDb({ logger: noopLogger, level: "trace" });
const dbTraceNoParams = makeDb({
  logger: noopLogger,
  level: "trace",
  sql: { parameters: "off" },
});

const dbWideOff = dbOff;
const dbWideTrace = dbTrace;
const dbWideTraceNoParams = dbTraceNoParams;

export const loggingScenarios: readonly BenchmarkScenario[] = [
  {
    group: "orm logging verbosity",
    name: "off (no logger) — default path",
    baseline: true,
    async fn() {
      await dbOff.query(typicalQuery);
    },
  },
  {
    group: "orm logging verbosity",
    name: "error (nothing fires on success)",
    async fn() {
      await dbError.query(typicalQuery);
    },
  },
  {
    group: "orm logging verbosity",
    name: "info (sql/result below threshold)",
    async fn() {
      await dbInfo.query(typicalQuery);
    },
  },
  {
    group: "orm logging verbosity",
    name: "debug (sql + result fire)",
    async fn() {
      await dbDebug.query(typicalQuery);
    },
  },
  {
    group: "orm logging verbosity",
    name: "trace (+ redacted bind params)",
    async fn() {
      await dbTrace.query(typicalQuery);
    },
  },
  {
    group: "orm logging verbosity",
    name: "trace, params off",
    async fn() {
      await dbTraceNoParams.query(typicalQuery);
    },
  },

  {
    group: "orm logging redaction cost (64 params)",
    name: "off (no logger)",
    baseline: true,
    async fn() {
      await dbWideOff.query(wideQuery);
    },
  },
  {
    group: "orm logging redaction cost (64 params)",
    name: "trace, params redacted",
    async fn() {
      await dbWideTrace.query(wideQuery);
    },
  },
  {
    group: "orm logging redaction cost (64 params)",
    name: "trace, params off",
    async fn() {
      await dbWideTraceNoParams.query(wideQuery);
    },
  },
];
