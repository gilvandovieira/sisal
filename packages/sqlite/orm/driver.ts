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

  return createSqliteOrmDriverFromExecutor(executor, true);
}

function createSqliteOrmDriverFromExecutor(
  executor: SqliteSqlExecutor,
  closeExecutor: boolean,
): OrmDriver {
  const transaction: OrmTransaction = {
    query<T = unknown>(query: SqlQuery): Promise<OrmQueryResult<T>> {
      return executeQuery<T>(executor, query);
    },

    execute(query: SqlQuery): Promise<OrmQueryResult> {
      return executeQuery(executor, query);
    },
  };

  // Without executor transaction support the driver omits transaction/batch,
  // so the ORM facade fails closed (ORM_TRANSACTION_UNSUPPORTED) instead of
  // silently losing atomicity.
  const executorTransaction = executor.transaction?.bind(executor);
  const atomic: Pick<OrmDriver, "transaction" | "batch"> =
    executorTransaction === undefined ? {} : {
      transaction<T>(fn: (tx: OrmTransaction) => Promise<T>): Promise<T> {
        return executorTransaction((txExecutor) => {
          return fn(createSqliteOrmDriverFromExecutor(txExecutor, false));
        });
      },

      // Runs the statements as one atomic transaction, collecting one result
      // per statement. Used by the non-interactive `db.batch(...)` API.
      batch(queries: readonly SqlQuery[]): Promise<OrmQueryResult[]> {
        return executorTransaction(async (txExecutor) => {
          const results: OrmQueryResult[] = [];
          for (const query of queries) {
            results.push(await executeQuery(txExecutor, query));
          }
          return results;
        });
      },
    };

  const driver: OrmDriver = {
    query<T = unknown>(query: SqlQuery): Promise<OrmQueryResult<T>> {
      return executeQuery<T>(executor, query);
    },

    execute(query: SqlQuery): Promise<OrmQueryResult> {
      return executeQuery(executor, query);
    },

    ...atomic,

    async close(): Promise<void> {
      if (!closeExecutor) {
        return;
      }

      await executor.close?.();
    },
  };

  return closeExecutor ? driver : transaction;
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
