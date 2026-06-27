import type { MigrationDriver } from "@sisal/migrate";

import {
  createSqliteExecutor,
  type SqlExecutor,
  type SqliteExecutorOptions,
} from "./executor.ts";
import { toSqliteMigrationError } from "./errors.ts";

/** Options for creating a SQLite-backed migration driver. */
export type SqliteMigrationDriverOptions = SqliteExecutorOptions;

/** Creates a core migration driver backed by SQLite SQL execution. */
export function createSqliteMigrationDriver(
  options: SqliteMigrationDriverOptions = {},
): MigrationDriver {
  const executor = createSqliteExecutor(options);

  return {
    async execute(sql: string): Promise<void> {
      try {
        await executor.execute(sql);
      } catch (error) {
        throw toSqliteMigrationError(error, "SQLite query failed", {
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
          throw toSqliteMigrationError(error, "SQLite query failed", {
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
