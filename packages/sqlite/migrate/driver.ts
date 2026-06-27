import type { MigrationDriver, MigrationTransaction } from "@sisal/migrate";

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

  return createSqliteMigrationDriverFromExecutor(executor, true);
}

function createSqliteMigrationDriverFromExecutor(
  executor: SqlExecutor,
  closeExecutor: boolean,
): MigrationDriver {
  const driver: MigrationDriver = {
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

    transaction<T>(fn: (tx: MigrationTransaction) => Promise<T>): Promise<T> {
      if (executor.transaction === undefined) {
        return fn({ driver });
      }

      return executor.transaction(async (txExecutor) => {
        const txDriver = createSqliteMigrationDriverFromExecutor(
          txExecutor,
          false,
        );

        try {
          return await fn({ driver: txDriver });
        } catch (error) {
          throw toSqliteMigrationError(error, "SQLite query failed", {
            code: "MIGRATION_EXECUTE_FAILED",
          });
        }
      });
    },

    async close(): Promise<void> {
      if (!closeExecutor) {
        return;
      }

      await executor.close?.();
    },
  };

  return driver;
}

export type { SqlExecutor };
