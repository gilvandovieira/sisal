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
