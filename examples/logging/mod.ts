/**
 * Concrete Sisal logging examples for `@std/log` and Pino.
 *
 * Run one logger:
 *
 * ```sh
 * deno task std
 * deno task pino
 * ```
 *
 * Or run both:
 *
 * ```sh
 * deno task run
 * ```
 *
 * @module
 */

import { runPinoExample } from "./pino.ts";
import { runStdLogExample } from "./std_log.ts";

if (import.meta.main) {
  console.log("\n--- @std/log ---");
  await runStdLogExample();

  console.log("\n--- pino ---");
  await runPinoExample();
}
