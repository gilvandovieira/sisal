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
import { consoleLogger } from "@sisal/orm";

if (import.meta.main) {
  console.log("\n--- @std/log (parameters: redacted) ---");
  await runStdLogExample();

  console.log("\n--- pino (parameters: redacted) ---");
  await runPinoExample();

  // The bundled zero-setup sink, with bind summaries switched fully off.
  console.log("\n--- consoleLogger(), parameters: 'off' ---");
  await runSisalLoggingDemo(consoleLogger(), { parameters: "off" });
}
