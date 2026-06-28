import type {
  OrmDriver,
  OrmQueryResult,
  OrmTransaction,
  SqlQuery,
} from "@sisal/orm";

import {
  createPgExecutor,
  type PgQueryResult,
  type PgSqlExecutor,
} from "./executor.ts";
import type { PgConnectionOptions } from "./pool.ts";

/** Options for creating a PostgreSQL-backed ORM driver. */
export interface PgOrmDriverOptions extends PgConnectionOptions {
  readonly executor?: PgSqlExecutor;
}

/** Creates an ORM driver backed by a PostgreSQL executor, pool, client, or URL. */
export function createPgOrmDriver(options: PgOrmDriverOptions): OrmDriver {
  const executor = createPgExecutor(options);

  return createPgOrmDriverFromExecutor(executor, true);
}

function createPgOrmDriverFromExecutor(
  executor: PgSqlExecutor,
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

      return executor.transaction((txExecutor) => {
        return fn(createPgOrmDriverFromExecutor(txExecutor, false));
      });
    },

    batch(queries: readonly SqlQuery[]): Promise<OrmQueryResult[]> {
      return executeBatch(executor, queries);
    },

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
  executor: PgSqlExecutor,
  query: SqlQuery,
): Promise<OrmQueryResult<T>> {
  const result: PgQueryResult<T> = await executor.execute<T>(
    query.text,
    query.params,
  );

  return {
    rows: result.rows,
    rowCount: result.rowCount,
  };
}

// Runs the statements as one atomic transaction (begin/commit), collecting one
// result per statement. Used by the non-interactive `db.batch(...)` API.
async function executeBatch(
  executor: PgSqlExecutor,
  queries: readonly SqlQuery[],
): Promise<OrmQueryResult[]> {
  if (executor.transaction === undefined) {
    const results: OrmQueryResult[] = [];
    for (const query of queries) {
      results.push(await executeQuery(executor, query));
    }
    return results;
  }

  return await executor.transaction(async (txExecutor) => {
    const results: OrmQueryResult[] = [];
    for (const query of queries) {
      results.push(await executeQuery(txExecutor, query));
    }
    return results;
  });
}
