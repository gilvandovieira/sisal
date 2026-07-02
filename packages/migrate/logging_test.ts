import { assert, assertEquals } from "@std/assert";
import type { Logger } from "@sisal/core";
import {
  createMigrator,
  defineMigration,
  defineSqlMigration,
  memoryMigrationStore,
  type MigrationDriver,
} from "./mod.ts";

interface LogEntry {
  readonly method: string;
  readonly message: string;
  readonly record?: Record<string, unknown>;
}

function recordingLogger(entries: LogEntry[]): Logger {
  const method = (name: string) =>
    ((first: string | Record<string, unknown>, second?: string) => {
      if (second === undefined) {
        entries.push({ method: name, message: String(first) });
        return;
      }
      entries.push({
        method: name,
        record: first as Record<string, unknown>,
        message: second,
      });
    }) as Logger["debug"];

  return {
    debug: method("debug"),
    info: method("info"),
    warn: method("warn"),
    error: method("error"),
  };
}

function recordingDriver(executed: string[]): MigrationDriver {
  return {
    execute(sql: string): Promise<void> {
      executed.push(sql);
      return Promise.resolve();
    },
  };
}

Deno.test("migrator logging: debug emits plan, lock, step, sql, and history categories", async () => {
  const entries: LogEntry[] = [];
  const executed: string[] = [];
  const migrator = createMigrator({
    migrations: [
      defineSqlMigration({
        id: "0001_init",
        up: "create table t (id int);",
      }),
    ],
    store: memoryMigrationStore(),
    driver: recordingDriver(executed),
    logging: {
      logger: recordingLogger(entries),
      level: "debug",
    },
    useTransaction: false,
  });

  await migrator.up();

  assertEquals(executed, ["create table t (id int);"]);
  const categories = entries.map((entry) => entry.record?.category);
  for (
    const category of [
      "migrate.plan",
      "migrate.lock",
      "migrate.step",
      "migrate.sql",
      "migrate.history",
    ]
  ) {
    assert(categories.includes(category), categories.join(", "));
  }
});

Deno.test("migrator logging: legacy logger does not receive new SQL/history events", async () => {
  const entries: LogEntry[] = [];
  const migrator = createMigrator({
    migrations: [
      defineSqlMigration({
        id: "0001_init",
        up: "create table t (id int);",
      }),
    ],
    store: memoryMigrationStore(),
    driver: recordingDriver([]),
    logger: recordingLogger(entries),
    useTransaction: false,
  });

  await migrator.up();

  assert(
    !entries.some((entry) =>
      entry.message === "migration sql executed" ||
      entry.message.startsWith("migration history ")
    ),
  );
});

Deno.test("migrator logging: programmatic migrations receive logging settings", async () => {
  const entries: LogEntry[] = [];
  let sawLogger = false;
  let sawLogging = false;
  const migrator = createMigrator({
    migrations: [
      defineMigration({
        id: "0001_programmatic",
        up(ctx) {
          sawLogger = ctx.logger !== undefined;
          sawLogging = ctx.logging?.level === "debug";
        },
      }),
    ],
    store: memoryMigrationStore(),
    driver: recordingDriver([]),
    logging: {
      logger: recordingLogger(entries),
      level: "debug",
    },
    useTransaction: false,
  });

  await migrator.up();

  assertEquals(sawLogger, true);
  assertEquals(sawLogging, true);
});

Deno.test("migrator logging: a throwing logger never breaks migration", async () => {
  const boom = (() => {
    throw new Error("logger boom");
  }) as Logger["debug"];
  const throwingLogger: Logger = {
    trace: boom,
    debug: boom,
    info: boom,
    warn: boom,
    error: boom,
  };
  const executed: string[] = [];
  const migrator = createMigrator({
    migrations: [
      defineSqlMigration({
        id: "0001_init",
        up: "create table t (id int);",
      }),
    ],
    store: memoryMigrationStore(),
    driver: recordingDriver(executed),
    // Trace fires plan/lock/step/sql/history; a throwing logger must not abort.
    logging: { logger: throwingLogger, level: "trace" },
    useTransaction: false,
  });

  await migrator.up();

  assertEquals(executed, ["create table t (id int);"]);
});

Deno.test("migrator logging: info threshold keeps step events but hides debug categories", async () => {
  const entries: LogEntry[] = [];
  const executed: string[] = [];
  const migrator = createMigrator({
    migrations: [
      defineSqlMigration({
        id: "0001_init",
        up: "create table t (id int);",
      }),
    ],
    store: memoryMigrationStore(),
    driver: recordingDriver(executed),
    logging: { logger: recordingLogger(entries), level: "info" },
    useTransaction: false,
  });

  await migrator.up();

  const categories = entries.map((entry) => entry.record?.category);
  // migrate.step is emitted at info; plan/sql/history are debug-only.
  assert(categories.includes("migrate.step"));
  for (
    const debugCategory of ["migrate.plan", "migrate.sql", "migrate.history"]
  ) {
    assert(
      !categories.includes(debugCategory),
      `${debugCategory} should be hidden at info`,
    );
  }
});

Deno.test("migrator logging: a disabled category vanishes while siblings remain", async () => {
  const entries: LogEntry[] = [];
  const migrator = createMigrator({
    migrations: [
      defineSqlMigration({
        id: "0001_init",
        up: "create table t (id int);",
      }),
    ],
    store: memoryMigrationStore(),
    driver: recordingDriver([]),
    logging: {
      logger: recordingLogger(entries),
      level: "debug",
      categories: { "migrate.sql": false },
    },
    useTransaction: false,
  });

  await migrator.up();

  const categories = entries.map((entry) => entry.record?.category);
  assert(!categories.includes("migrate.sql"));
  assert(categories.includes("migrate.step"));
  assert(categories.includes("migrate.history"));
});
