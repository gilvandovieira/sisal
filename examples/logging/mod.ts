/**
 * Concrete Sisal logging examples for `@std/log` and Pino.
 *
 * Demonstrates the safe observability posture: SQL text + result-shape logging
 * with bind parameters redacted (or omitted). See README.md.
 *
 * Run one logger, or both:
 *
 * ```sh
 * deno task std
 * deno task pino
 * deno task run     # both, redacted then with parameters "off"
 * ```
 *
 * @module
 */

import { runPinoExample } from "./pino.ts";
import { runStdLogExample } from "./std_log.ts";
import { runSisalLoggingDemo } from "./shared.ts";
import type { Logger, LoggerMethod } from "@sisal/orm";

/** Builds a `LoggerMethod` that prints its message (records are structured). */
function consoleMethod(level: string): LoggerMethod {
  return ((first: string | Record<string, unknown>, second?: string) => {
    console.log(level, second ?? first);
  }) as LoggerMethod;
}

/** A trivial console `Logger` used to contrast redaction modes. */
const consoleLogger: Logger = {
  trace: consoleMethod("trace"),
  debug: consoleMethod("debug"),
  info: consoleMethod("info"),
  warn: consoleMethod("warn"),
  error: consoleMethod("error"),
};

if (import.meta.main) {
  console.log("\n--- @std/log (parameters: redacted) ---");
  await runStdLogExample();

  console.log("\n--- pino (parameters: redacted) ---");
  await runPinoExample();

  console.log("\n--- parameters: 'off' (no bind summaries at all) ---");
  await runSisalLoggingDemo(consoleLogger, { parameters: "off" });
}
