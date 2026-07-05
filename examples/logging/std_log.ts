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
import { fromStdLog } from "@sisal/orm";
import type { Logger } from "@sisal/orm";
import { runSisalLoggingDemo } from "./shared.ts";

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
  return fromStdLog(logger);
}

export async function runStdLogExample(): Promise<void> {
  await runSisalLoggingDemo(createStdLogger());
}

if (import.meta.main) {
  await runStdLogExample();
}
