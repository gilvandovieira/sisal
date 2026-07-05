/**
 * Core `MigrationDriver` implementation backed by MySQL/MariaDB execution.
 *
 * @module
 */

import type {
  MigrationDriver,
  MigrationStore,
  MigrationTransaction,
} from "@sisal/migrate";

import type { MysqlConnectionOptions } from "../orm/pool.ts";
import { createMysqlMigrateExecutor, type SqlExecutor } from "./executor.ts";
import { toMysqlMigrationError } from "./errors.ts";

/** Options for creating a MySQL-backed migration driver. */
export interface MysqlMigrationDriverOptions extends MysqlConnectionOptions {
  /** Migration store used by this mysql migration driver options. */
  readonly executor?: SqlExecutor;
  /** Migration store used by this mysql migration driver options. */
  readonly transactionStoreFactory?: (executor: SqlExecutor) => MigrationStore;
}

/** Creates a core migration driver backed by MySQL SQL execution. */
export function createMysqlMigrationDriver(
  options: MysqlMigrationDriverOptions,
): MigrationDriver {
  const executor = createMysqlMigrateExecutor(options);

  return createMysqlMigrationDriverFromExecutor(executor, {
    closeExecutor: true,
    transactionStoreFactory: options.transactionStoreFactory,
  });
}

function createMysqlMigrationDriverFromExecutor(
  executor: SqlExecutor,
  options: {
    readonly closeExecutor: boolean;
    readonly transactionStoreFactory?: (
      executor: SqlExecutor,
    ) => MigrationStore;
  },
): MigrationDriver {
  const driver: MigrationDriver = {
    async execute(sql: string): Promise<void> {
      try {
        await executor.execute(sql);
      } catch (error) {
        throw toMysqlMigrationError(error, "MySQL query failed", {
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
        const driver = createMysqlMigrationDriverFromExecutor(txExecutor, {
          closeExecutor: false,
        });
        const store = options.transactionStoreFactory?.(txExecutor);

        try {
          return await fn({
            driver,
            ...(store === undefined ? {} : { store }),
          });
        } catch (error) {
          throw toMysqlMigrationError(error, "MySQL query failed", {
            code: "MIGRATION_EXECUTE_FAILED",
          });
        }
      });
    },

    async close(): Promise<void> {
      if (!options.closeExecutor) {
        return;
      }

      await executor.close?.();
    },
  };

  return driver;
}
