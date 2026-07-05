import { assert, assertEquals } from "@std/assert";
import {
  type ConsoleLike,
  consoleLogger,
  createSisalLogEmitter,
  developmentLogging,
  fromStdLog,
  type Logger,
  productionLogging,
  redactSqlParameters,
  renderSqlParametersForLog,
  type SisalLogEvent,
  type StdLogLike,
} from "../mod.ts";

interface LogEntry {
  readonly method: string;
  readonly message: string;
  readonly record?: Record<string, unknown>;
}

function recordingLogger(
  entries: LogEntry[],
): Logger {
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

Deno.test("logger: level thresholds and category overrides filter events", () => {
  const entries: LogEntry[] = [];
  const log = createSisalLogEmitter({
    logger: recordingLogger(entries),
    logging: {
      level: "error",
      categories: {
        "orm.sql": true,
        "migrate.lock": false,
      },
    },
  });

  log.emit({
    level: "debug",
    category: "orm.sql",
    record: { sql: "select 1" },
    message: "orm query started",
  });
  log.emit({
    level: "debug",
    category: "migrate.lock",
    record: { lockId: "sisal:migrate" },
    message: "migration lock acquired",
  });
  log.emit({
    level: "warn",
    category: "cli",
    message: "suppressed warning",
  });
  log.emit({
    level: "error",
    category: "cli",
    message: "visible error",
  });

  assertEquals(entries.map((entry) => entry.message), [
    "orm query started",
    "visible error",
  ]);
  assertEquals(entries[0].record?.category, "orm.sql");
  assertEquals(entries[0].record?.level, "debug");
});

Deno.test("logger: trace emits structured trace metadata", () => {
  const entries: LogEntry[] = [];
  const log = createSisalLogEmitter({
    logger: recordingLogger(entries),
    logging: { level: "trace" },
  });

  log.emit({
    level: "trace",
    category: "orm.bind",
    record: { params: [] },
    message: "orm query parameters",
  });

  assertEquals(entries.length, 1);
  assertEquals(entries[0].method, "trace");
  assertEquals(entries[0].record?.level, "trace");
  assertEquals(entries[0].record?.category, "orm.bind");
});

Deno.test("logger: SQL parameters are redacted summaries, not raw values", () => {
  const params = redactSqlParameters([
    "password=swordfish",
    true,
    42,
    new Uint8Array([1, 2, 3]),
    { token: "secret", visible: "name" },
  ]);
  const serialized = JSON.stringify(params);

  assertEquals(params[0], {
    type: "string",
    length: "password=swordfish".length,
    redacted: true,
  });
  assertEquals(params[1], { type: "boolean", value: true });
  assertEquals(params[2], { type: "number", value: 42 });
  assertEquals(params[3], { type: "bytes", byteLength: 3 });
  assert(
    !serialized.includes("swordfish") && !serialized.includes('"secret"'),
    serialized,
  );
});

Deno.test("logger: renderSqlParametersForLog keeps raw values in 'values' mode", () => {
  const params = ["password=swordfish", 42];

  const redacted = renderSqlParametersForLog(params, "redacted");
  assert(!JSON.stringify(redacted).includes("swordfish"));

  const raw = renderSqlParametersForLog(params, "values");
  assertEquals(raw, params);
  assert(JSON.stringify(raw).includes("swordfish"));
});

Deno.test("logger: no logger attached emits nothing (silent by default)", () => {
  const log = createSisalLogEmitter({ logging: { level: "trace" } });
  assertEquals(log.enabled("error", "orm.query"), false);
  // emit must be a safe no-op with no sink.
  log.emit({ level: "error", category: "orm.query", message: "boom" });
});

Deno.test("logger: Logger.isEnabled narrows what Sisal builds", () => {
  const seen: SisalLogEvent[] = [];
  const sink: Logger = {
    isEnabled(level) {
      return level === "error";
    },
    log(event) {
      seen.push(event);
    },
  };
  const log = createSisalLogEmitter({
    logger: sink,
    logging: { level: "trace" },
  });

  // Sisal's own gate says trace is fine, but the sink only wants error.
  assertEquals(log.enabled("debug", "orm.sql"), false);
  assertEquals(log.enabled("error", "orm.query"), true);

  log.emit({ level: "debug", category: "orm.sql", message: "dropped" });
  log.emit({ level: "error", category: "orm.query", message: "kept" });
  assertEquals(seen.map((event) => event.message), ["kept"]);
});

Deno.test("logger: consoleLogger routes levels and gates on its own level", () => {
  const calls: Array<[string, string]> = [];
  const fakeConsole: ConsoleLike = {
    error: (line) => calls.push(["error", String(line)]),
    warn: (line) => calls.push(["warn", String(line)]),
    info: (line) => calls.push(["info", String(line)]),
    debug: (line) => calls.push(["debug", String(line)]),
  };
  const logger = consoleLogger({ console: fakeConsole, level: "warn" });

  assertEquals(logger.isEnabled?.("error", "cli"), true);
  assertEquals(logger.isEnabled?.("debug", "cli"), false);

  logger.log({ level: "error", category: "orm.query", message: "failed" });
  logger.log({
    level: "info",
    category: "orm.sql",
    message: "select",
    record: { sql: "select 1" },
  });

  assertEquals(calls[0][0], "error");
  assert(calls[0][1].includes("[error] orm.query: failed"));
  assertEquals(calls[1][0], "info");
  assert(calls[1][1].includes('{"sql":"select 1"}'));
});

Deno.test("logger: fromStdLog maps events and folds trace into debug", () => {
  const calls: Array<[string, string, unknown]> = [];
  const record = (method: string) => (message: string, ...args: unknown[]) => {
    calls.push([method, message, args[0]]);
  };
  const std: StdLogLike = {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
  const logger = fromStdLog(std);

  logger.log({ level: "trace", category: "orm.bind", message: "params" });
  logger.log({
    level: "warn",
    category: "cli",
    message: "careful",
    record: { n: 1 },
  });

  assertEquals(calls[0], ["debug", "params", undefined]);
  assertEquals(calls[1], ["warn", "careful", { n: 1 }]);
});

Deno.test("logger: presets pair a sink with dev/prod verbosity", () => {
  const sink: Logger = { log() {} };

  const dev = developmentLogging(sink);
  assertEquals(dev.logger, sink);
  assertEquals(dev.level, "debug");
  assertEquals(dev.sql?.parameters, "values");
  assertEquals(dev.categories?.["orm.bind"], "trace");

  const prod = productionLogging(sink);
  assertEquals(prod.logger, sink);
  assertEquals(prod.level, "warn");
  assertEquals(prod.sql?.parameters, "redacted");
});
