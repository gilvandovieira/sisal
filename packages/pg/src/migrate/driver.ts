import type {
  MigrationDriver,
  MigrationStore,
  MigrationTransaction,
} from "@sisal/migrate";

import { createPgExecutor, type SqlExecutor } from "./executor.ts";
import { toPgMigrationError } from "./errors.ts";
import type { PgConnectionOptions } from "./pool.ts";

/** Options for creating a PostgreSQL-backed migration driver. */
export interface PgMigrationDriverOptions extends PgConnectionOptions {
  /** Migration store used by this pg migration driver options. */
  readonly executor?: SqlExecutor;
  /** Migration store used by this pg migration driver options. */
  readonly transactionStoreFactory?: (executor: SqlExecutor) => MigrationStore;
}

/** Creates a core migration driver backed by PostgreSQL SQL execution. */
export function createPgMigrationDriver(
  options: PgMigrationDriverOptions,
): MigrationDriver {
  const executor = createPgExecutor(options);

  return createPgMigrationDriverFromExecutor(executor, {
    closeExecutor: true,
    transactionStoreFactory: options.transactionStoreFactory,
  });
}

function createPgMigrationDriverFromExecutor(
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
        throw toPgMigrationError(error, "PostgreSQL query failed", {
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
        const driver = createPgMigrationDriverFromExecutor(txExecutor, {
          closeExecutor: false,
        });
        const store = options.transactionStoreFactory?.(txExecutor);

        try {
          return await fn({
            driver,
            ...(store === undefined ? {} : { store }),
          });
        } catch (error) {
          throw toPgMigrationError(error, "PostgreSQL query failed", {
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
