import type {
  OrmDriver,
  OrmQueryResult,
  OrmTransaction,
  SqlQuery,
} from "@sisal/orm";

import {
  createSqliteExecutor,
  type SqliteExecutorOptions,
  type SqliteQueryResult,
  type SqliteSqlExecutor,
} from "./executor.ts";

/** Options for creating a SQLite-backed ORM driver. */
export type SqliteOrmDriverOptions = SqliteExecutorOptions;

/** Creates an ORM driver backed by a SQLite executor or open database. */
export function createSqliteOrmDriver(
  options: SqliteOrmDriverOptions = {},
): OrmDriver {
  const executor = createSqliteExecutor(options);

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
  executor: SqliteSqlExecutor,
  query: SqlQuery,
): Promise<OrmQueryResult<T>> {
  const result: SqliteQueryResult<T> = await executor.execute<T>(
    query.text,
    query.params,
  );

  return {
    rows: result.rows,
    rowCount: result.rowCount,
  };
}
