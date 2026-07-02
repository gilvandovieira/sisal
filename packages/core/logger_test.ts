import { assert, assertEquals } from "@std/assert";
import {
  createSisalLogEmitter,
  type Logger,
  redactSqlParameters,
} from "./mod.ts";

interface LogEntry {
  readonly method: string;
  readonly message: string;
  readonly record?: Record<string, unknown>;
}

function recordingLogger(
  entries: LogEntry[],
  options: { readonly trace?: boolean } = {},
): Logger {
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
    ...(options.trace === false ? {} : { trace: method("trace") }),
    debug: method("debug"),
    info: method("info"),
    warn: method("warn"),
    error: method("error"),
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

Deno.test("logger: trace falls back to debug with trace metadata", () => {
  const entries: LogEntry[] = [];
  const log = createSisalLogEmitter({
    logger: recordingLogger(entries, { trace: false }),
    logging: { level: "trace" },
  });

  log.emit({
    level: "trace",
    category: "orm.bind",
    record: { params: [] },
    message: "orm query parameters",
  });

  assertEquals(entries.length, 1);
  assertEquals(entries[0].method, "debug");
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
