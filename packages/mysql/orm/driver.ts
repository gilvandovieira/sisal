import type {
  OrmDriver,
  OrmQueryResult,
  OrmTransaction,
  SqlQuery,
} from "@sisal/orm";

import {
  createMysqlExecutor,
  type MysqlQueryResult,
  type MysqlSqlExecutor,
} from "./executor.ts";
import type { MysqlConnectionOptions } from "./pool.ts";

/** Options for creating a MySQL-backed ORM driver. */
export interface MysqlOrmDriverOptions extends MysqlConnectionOptions {
  readonly executor?: MysqlSqlExecutor;
}

/** Creates an ORM driver backed by a MySQL executor, pool, client, or URL. */
export function createMysqlOrmDriver(
  options: MysqlOrmDriverOptions,
): OrmDriver {
  const executor = createMysqlExecutor(options);

  return createMysqlOrmDriverFromExecutor(executor, true);
}

function createMysqlOrmDriverFromExecutor(
  executor: MysqlSqlExecutor,
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
          return fn(createMysqlOrmDriverFromExecutor(txExecutor, false));
        });
      },

      // Runs the statements as one atomic transaction (begin/commit),
      // collecting one result per statement. Used by the non-interactive
      // `db.batch(...)` API.
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
  executor: MysqlSqlExecutor,
  query: SqlQuery,
): Promise<OrmQueryResult<T>> {
  const result: MysqlQueryResult<T> = await executor.execute<T>(
    query.text,
    query.params,
  );

  return {
    rows: result.rows,
    rowCount: result.rowCount,
    // Carried past OrmQueryResult's structural type so the B7
    // `insertReturning` fallback can read the statement's LAST_INSERT_ID
    // from a facade-level result.
    ...(result.insertId === undefined ? {} : { insertId: result.insertId }),
  } as OrmQueryResult<T>;
}
