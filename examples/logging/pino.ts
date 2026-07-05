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
    isEnabled(level) {
      return logger.isLevelEnabled(level);
    },
    log(event) {
      const method = logger[event.level].bind(logger);
      if (event.record === undefined) {
        method(event.message);
      } else {
        method(event.record, event.message);
      }
    },
  };
}

export async function runPinoExample(): Promise<void> {
  await runSisalLoggingDemo(createPinoLogger());
}

if (import.meta.main) {
  await runPinoExample();
}
