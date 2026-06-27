import type { MigrationDriver } from "@sisal/migrate";

import {
  createLibsqlExecutor,
  type LibsqlExecutorOptions,
  type SqlExecutor,
} from "./executor.ts";
import { toLibsqlMigrationError } from "./errors.ts";

/** Options for creating a libSQL-backed migration driver. */
export type LibsqlMigrationDriverOptions = LibsqlExecutorOptions;

/** Creates a core migration driver backed by libSQL SQL execution. */
export function createLibsqlMigrationDriver(
  options: LibsqlMigrationDriverOptions = {},
): MigrationDriver {
  const executor = createLibsqlExecutor(options);

  return {
    async execute(sql: string): Promise<void> {
      try {
        await executor.execute(sql);
      } catch (error) {
        throw toLibsqlMigrationError(error, "libSQL query failed", {
          code: "MIGRATION_EXECUTE_FAILED",
          sql,
        });
      }
    },

    transaction<T>(fn: () => Promise<T>): Promise<T> {
      if (executor.transaction === undefined) {
        return fn();
      }

      return executor.transaction(async () => {
        try {
          return await fn();
        } catch (error) {
          throw toLibsqlMigrationError(error, "libSQL query failed", {
            code: "MIGRATION_EXECUTE_FAILED",
          });
        }
      });
    },

    async close(): Promise<void> {
      await executor.close?.();
    },
  };
}

export type { SqlExecutor };
