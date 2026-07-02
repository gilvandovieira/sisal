/**
 * Sisal logging with `@std/log`.
 *
 * Run:
 *
 * ```sh
 * deno task std
 * ```
 *
 * @module
 */

import * as log from "@std/log";
import type { Logger, LoggerMethod } from "@sisal/orm";
import { runSisalLoggingDemo } from "./shared.ts";

function toStdMethod(
  method: (message: string, ...args: unknown[]) => unknown,
): LoggerMethod {
  return ((first: string | Record<string, unknown>, second?: string) => {
    if (second === undefined) {
      method(String(first));
      return;
    }

    method(second, first);
  }) as LoggerMethod;
}

function createStdLogger(): Logger {
  log.setup({
    handlers: {
      console: new log.ConsoleHandler("DEBUG", {
        formatter: log.formatters.jsonFormatter,
        useColors: false,
      }),
    },
    loggers: {
      sisal: {
        level: "DEBUG",
        handlers: ["console"],
      },
    },
  });

  const logger = log.getLogger("sisal");

  return {
    trace: toStdMethod(logger.debug.bind(logger)),
    debug: toStdMethod(logger.debug.bind(logger)),
    info: toStdMethod(logger.info.bind(logger)),
    warn: toStdMethod(logger.warn.bind(logger)),
    error: toStdMethod(logger.error.bind(logger)),
  };
}

export async function runStdLogExample(): Promise<void> {
  await runSisalLoggingDemo(createStdLogger());
}

if (import.meta.main) {
  await runStdLogExample();
}
