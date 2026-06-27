import type {
  OrmDriver,
  OrmQueryResult,
  OrmTransaction,
  SqlQuery,
} from "@sisal/orm";

import {
  createLibsqlExecutor,
  type LibsqlExecutorOptions,
  type LibsqlQueryResult,
  type LibsqlSqlExecutor,
} from "./executor.ts";

/** Options for creating a libSQL-backed ORM driver. */
export type LibsqlOrmDriverOptions = LibsqlExecutorOptions;

/** Creates an ORM driver backed by a libSQL executor or open client. */
export function createLibsqlOrmDriver(
  options: LibsqlOrmDriverOptions = {},
): OrmDriver {
  const executor = createLibsqlExecutor(options);

  const driver: OrmDriver = {
    query<T = unknown>(query: SqlQuery): Promise<OrmQueryResult<T>> {
      return executeQuery<T>(executor, query);
    },

    execute(query: SqlQuery): Promise<OrmQueryResult> {
      return executeQuery(executor, query);
    },

    transaction<T>(fn: (tx: OrmTransaction) => Promise<T>): Promise<T> {
      if (executor.transaction === undefined) {
        return fn(driver);
      }

      return executor.transaction(() => fn(driver));
    },

    async close(): Promise<void> {
      await executor.close?.();
    },
  };

  return driver;
}

async function executeQuery<T>(
  executor: LibsqlSqlExecutor,
  query: SqlQuery,
): Promise<OrmQueryResult<T>> {
  const result: LibsqlQueryResult<T> = await executor.execute<T>(
    query.text,
    query.params,
  );

  return {
    rows: result.rows,
    rowCount: result.rowCount,
  };
}
