import type {
  MigrationDriver,
  MigrationStore,
  MigrationTransaction,
} from "@sisal/migrate";

import {
  createLibsqlExecutor,
  type LibsqlExecutorOptions,
  type SqlExecutor,
} from "./executor.ts";
import { toLibsqlMigrationError } from "./errors.ts";

/** Options for creating a libSQL-backed migration driver. */
export interface LibsqlMigrationDriverOptions extends LibsqlExecutorOptions {
  readonly transactionStoreFactory?: (executor: SqlExecutor) => MigrationStore;
}

/** Creates a core migration driver backed by libSQL SQL execution. */
export function createLibsqlMigrationDriver(
  options: LibsqlMigrationDriverOptions = {},
): MigrationDriver {
  const executor = createLibsqlExecutor(options);

  return createLibsqlMigrationDriverFromExecutor(executor, {
    closeExecutor: true,
    transactionStoreFactory: options.transactionStoreFactory,
  });
}

function createLibsqlMigrationDriverFromExecutor(
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
        throw toLibsqlMigrationError(error, "libSQL query failed", {
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
        const txDriver = createLibsqlMigrationDriverFromExecutor(txExecutor, {
          closeExecutor: false,
        });
        const store = options.transactionStoreFactory?.(txExecutor);

        try {
          return await fn({
            driver: txDriver,
            ...(store === undefined ? {} : { store }),
          });
        } catch (error) {
          throw toLibsqlMigrationError(error, "libSQL query failed", {
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

export type { SqlExecutor };
