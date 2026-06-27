import type { MigrationDriver } from "@sisal/migrate";

import { createPgExecutor, type SqlExecutor } from "./executor.ts";
import { toPgMigrationError } from "./errors.ts";
import type { PgConnectionOptions } from "./pool.ts";

/** Options for creating a PostgreSQL-backed migration driver. */
export interface PgMigrationDriverOptions extends PgConnectionOptions {
  readonly executor?: SqlExecutor;
}

/** Creates a core migration driver backed by PostgreSQL SQL execution. */
export function createPgMigrationDriver(
  options: PgMigrationDriverOptions,
): MigrationDriver {
  const executor = createPgExecutor(options);

  return {
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

    transaction<T>(fn: () => Promise<T>): Promise<T> {
      if (executor.transaction === undefined) {
        return fn();
      }

      return executor.transaction(async () => {
        try {
          return await fn();
        } catch (error) {
          throw toPgMigrationError(error, "PostgreSQL query failed", {
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
