/**
 * Sisal logging with Pino.
 *
 * Run:
 *
 * ```sh
 * deno task pino
 * ```
 *
 * @module
 */

import pino from "pino";
import type { Logger } from "@sisal/orm";
import { runSisalLoggingDemo } from "./shared.ts";

function createPinoLogger(): Logger {
  const logger = pino(
    {
      level: "trace",
      base: undefined,
      formatters: {
        level(_label, number) {
          return { severity: number };
        },
      },
    },
    pino.destination({ sync: true }),
  ).child({ component: "sisal" });

  return {
    trace: logger.trace.bind(logger),
    debug: logger.debug.bind(logger),
    info: logger.info.bind(logger),
    warn: logger.warn.bind(logger),
    error: logger.error.bind(logger),
  };
}

export async function runPinoExample(): Promise<void> {
  await runSisalLoggingDemo(createPinoLogger());
}

if (import.meta.main) {
  await runPinoExample();
}
