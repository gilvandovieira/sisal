import { assert, assertEquals } from "@std/assert";
import {
  createDatabase,
  type Logger,
  type OrmDriver,
  type OrmQueryResult,
  type SqlQuery,
} from "../mod.ts";

interface LogEntry {
  readonly method: string;
  readonly message: string;
  readonly record?: Record<string, unknown>;
}

function recordingLogger(entries: LogEntry[]): Logger {
  return {
    log(event) {
      entries.push({
        method: event.level,
        message: event.message,
        record: event.record,
      });
    },
  };
}

function emptyDriver(): OrmDriver {
  return {
    query<T = unknown>(_query: SqlQuery): Promise<OrmQueryResult<T>> {
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    execute<T = unknown>(_query: SqlQuery): Promise<OrmQueryResult<T>> {
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
}

Deno.test("orm logging: legacy logger keeps debug events without bind logs", async () => {
  const entries: LogEntry[] = [];
  const db = createDatabase({
    dialect: "postgres",
    driver: emptyDriver(),
    logger: recordingLogger(entries),
  });

  await db.execute("select $1", ["password=swordfish"]);

  assertEquals(entries.map((entry) => entry.message), [
    "orm query started",
    "orm query completed",
  ]);
  assertEquals(entries[0].record?.category, undefined);
  assertEquals(entries[0].record?.level, undefined);
  assert(!JSON.stringify(entries).includes("swordfish"));
});

Deno.test("orm logging: debug logs SQL and result but not bind summaries", async () => {
  const entries: LogEntry[] = [];
  const db = createDatabase({
    dialect: "postgres",
    driver: emptyDriver(),
    logging: {
      logger: recordingLogger(entries),
      level: "debug",
    },
  });

  await db.execute("select $1", ["password=swordfish"]);

  assertEquals(
    entries.map((entry) => entry.record?.category),
    ["orm.sql", "orm.result"],
  );
  assert(!entries.some((entry) => entry.record?.category === "orm.bind"));
  assert(!JSON.stringify(entries).includes("swordfish"));
});

Deno.test("orm logging: trace logs redacted bind summaries", async () => {
  const entries: LogEntry[] = [];
  const db = createDatabase({
    dialect: "postgres",
    driver: emptyDriver(),
    logging: {
      logger: recordingLogger(entries),
      level: "trace",
    },
  });

  await db.execute("select $1", ["password=swordfish"]);

  const bind = entries.find((entry) => entry.record?.category === "orm.bind");
  assert(bind !== undefined);
  assertEquals(bind.record?.level, "trace");
  assertEquals(bind.record?.params, [{
    type: "string",
    length: "password=swordfish".length,
    redacted: true,
  }]);
  assert(!JSON.stringify(entries).includes("swordfish"));
});

Deno.test("orm logging: sql.parameters 'off' suppresses bind summaries at trace", async () => {
  const entries: LogEntry[] = [];
  const db = createDatabase({
    dialect: "postgres",
    driver: emptyDriver(),
    logging: {
      logger: recordingLogger(entries),
      level: "trace",
      sql: { parameters: "off" },
    },
  });

  await db.execute("select $1", ["password=swordfish"]);

  assert(!entries.some((entry) => entry.record?.category === "orm.bind"));
  // SQL and result still log at trace; only the bind summary is suppressed.
  assert(entries.some((entry) => entry.record?.category === "orm.sql"));
  assert(!JSON.stringify(entries).includes("swordfish"));
});

Deno.test("orm logging: sql.parameters 'values' logs raw bind values", async () => {
  const entries: LogEntry[] = [];
  const db = createDatabase({
    dialect: "postgres",
    driver: emptyDriver(),
    logging: {
      logger: recordingLogger(entries),
      level: "trace",
      sql: { parameters: "values" },
    },
  });

  await db.execute("select $1", ["needle-42"]);

  const bind = entries.find((entry) => entry.record?.category === "orm.bind");
  assert(bind !== undefined);
  // Opt-in raw mode: the actual value reaches the sink for replay/debugging.
  assertEquals(bind.record?.params, ["needle-42"]);
  assert(JSON.stringify(entries).includes("needle-42"));
});

Deno.test("orm logging: a sink that disables every level gets nothing", async () => {
  const entries: LogEntry[] = [];
  const base = recordingLogger(entries);
  const db = createDatabase({
    dialect: "postgres",
    driver: emptyDriver(),
    logging: {
      // Sisal's own gate is wide open at trace, but the sink refuses all
      // levels — the hot path must skip building any event.
      logger: { isEnabled: () => false, log: base.log },
      level: "trace",
      sql: { parameters: "values" },
    },
  });

  await db.execute("select $1", ["password=swordfish"]);
  assertEquals(entries.length, 0);
});

Deno.test("orm logging: a throwing logger never breaks query execution", async () => {
  const throwingLogger: Logger = {
    log() {
      throw new Error("logger boom");
    },
  };
  const db = createDatabase({
    dialect: "postgres",
    driver: emptyDriver(),
    // Trace fires every event (sql + bind + result); none may escape emit().
    logging: { logger: throwingLogger, level: "trace" },
  });

  const result = await db.execute("select $1", ["password=swordfish"]);
  assertEquals(result.rowCount, 0);
});

Deno.test("orm logging: disabled categories vanish end-to-end while siblings remain", async () => {
  const entries: LogEntry[] = [];
  const db = createDatabase({
    dialect: "postgres",
    driver: emptyDriver(),
    logging: {
      logger: recordingLogger(entries),
      level: "trace",
      categories: { "orm.sql": false, "orm.result": false },
    },
  });

  await db.execute("select $1", ["password=swordfish"]);

  const categories = entries.map((entry) => entry.record?.category);
  assert(!categories.includes("orm.sql"));
  assert(!categories.includes("orm.result"));
  assert(categories.includes("orm.bind")); // still on at trace
  assert(!JSON.stringify(entries).includes("swordfish"));
});

Deno.test("orm logging: a per-category override lifts orm.bind above the base level", async () => {
  const entries: LogEntry[] = [];
  const db = createDatabase({
    dialect: "postgres",
    driver: emptyDriver(),
    logging: {
      logger: recordingLogger(entries),
      // bind is a trace event, normally below a debug base — the category
      // override raises just orm.bind to trace, which the redaction guard honors.
      level: "debug",
      categories: { "orm.bind": "trace" },
    },
  });

  await db.execute("select $1", ["password=swordfish"]);

  const bind = entries.find((entry) => entry.record?.category === "orm.bind");
  assert(
    bind !== undefined,
    "orm.bind should fire when its category is raised",
  );
  assertEquals(bind.record?.level, "trace");
  assert(!JSON.stringify(entries).includes("swordfish"));
});
