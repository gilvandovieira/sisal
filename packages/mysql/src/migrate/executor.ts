/**
 * SQL executor seam for the MySQL/MariaDB migration adapter.
 *
 * Mirrors the pg migrate executor: a minimal injectable `execute`/
 * `transaction`/`acquireSession` contract so the history store and migrator
 * stay unit-testable without a driver. `acquireSession` pins one pooled
 * connection across calls — required for `GET_LOCK`, which is
 * **connection-scoped** (the lock dies with the connection and
 * `RELEASE_LOCK` must run on the same one).
 *
 * @module
 */

import {
  type MysqlClient,
  type MysqlConnectionOptions,
  type MysqlConnectionSource,
  type MysqlDriverRows,
  resolveMysqlConnectionSource,
} from "../orm/pool.ts";
import { toMysqlMigrationError } from "./errors.ts";

/** Rows and affected-row count returned by a MySQL migration executor. */
export interface QueryResult<Row = Record<string, unknown>> {
  readonly rows: Row[];
  readonly rowCount: number;
}

/** Pinned MySQL execution session held across multiple executor calls. */
export interface SqlExecutorSession {
  execute<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;

  release(): Promise<void>;
}

/** Minimal SQL executor used by the MySQL migration adapter. */
export interface SqlExecutor {
  execute<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;

  transaction?<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  acquireSession?(): Promise<SqlExecutorSession>;
  close?(): Promise<void>;
}

interface AcquiredClient {
  readonly client: MysqlClient;
  release(): void;
}

/**
 * Creates a MySQL SQL executor from an existing executor, pool, client, or
 * URL. URL connections reuse the ORM adapter's source routing, so
 * `driver: "mariadb"` and the mandated bigint-as-string options apply here
 * too.
 */
export function createMysqlMigrateExecutor(
  options: MysqlConnectionOptions & {
    readonly executor?: SqlExecutor;
  },
): SqlExecutor {
  if (options.executor !== undefined) {
    return options.executor;
  }

  return new SisalMysqlMigrateExecutor(resolveMysqlConnectionSource(options));
}

// Maps a driver result (row array for reads, affected-rows header for
// writes) into the executor's uniform {rows, rowCount} shape.
function toQueryResult<Row>(rows: MysqlDriverRows<Row>): QueryResult<Row> {
  if (Array.isArray(rows)) {
    return { rows, rowCount: rows.length };
  }
  return { rows: [], rowCount: rows.affectedRows };
}

class SisalMysqlMigrateExecutor implements SqlExecutor {
  readonly #source: MysqlConnectionSource;
  readonly #sessions = new Set<AcquiredClient>();
  #closed = false;

  constructor(source: MysqlConnectionSource) {
    this.#source = source;
  }

  async execute<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const acquired = await this.#acquireClient();

    try {
      return await this.#executeWithClient<Row>(acquired.client, sql, params);
    } finally {
      acquired.release();
    }
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const acquired = await this.#acquireClient();

    try {
      return await this.#transactionWithClient(acquired.client, fn);
    } finally {
      acquired.release();
    }
  }

  async acquireSession(): Promise<SqlExecutorSession> {
    const acquired = await this.#acquireClient();
    this.#sessions.add(acquired);
    let released = false;

    return {
      execute: <Row = Record<string, unknown>>(
        sql: string,
        params: readonly unknown[] = [],
      ): Promise<QueryResult<Row>> => {
        return this.#executeWithClient<Row>(acquired.client, sql, params);
      },

      release: (): Promise<void> => {
        if (released) {
          return Promise.resolve();
        }

        released = true;
        this.#sessions.delete(acquired);
        acquired.release();
        return Promise.resolve();
      },
    };
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }

    this.#closed = true;

    for (const session of this.#sessions) {
      session.release();
    }
    this.#sessions.clear();

    if (this.#source.ownsPool && this.#source.pool?.end !== undefined) {
      await this.#source.pool.end();
    }

    if (this.#source.ownsClient && this.#source.client?.end !== undefined) {
      await this.#source.client.end();
    }
  }

  async #acquireClient(): Promise<AcquiredClient> {
    if (this.#source.client !== undefined) {
      return {
        client: this.#source.client,
        release() {},
      };
    }

    try {
      const client = await this.#source.pool!.getConnection();

      return {
        client,
        release() {
          client.release?.();
        },
      };
    } catch (error) {
      throw toMysqlMigrationError(error, "MySQL connection failed", {
        code: "MIGRATION_CONNECTION_FAILED",
        status: 503,
      });
    }
  }

  async #transactionWithClient<T>(
    client: MysqlClient,
    fn: (tx: SqlExecutor) => Promise<T>,
  ): Promise<T> {
    const tx = this.#createTransactionExecutor(client);

    await tx.execute("begin");

    try {
      const result = await fn(tx);
      await tx.execute("commit");
      return result;
    } catch (error) {
      try {
        await tx.execute("rollback");
      } catch {
        // Preserve the original migration failure.
      }

      throw error;
    }
  }

  async #executeWithClient<Row>(
    client: MysqlClient,
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    try {
      const [rows] = await client.query<Row>(sql, [...params]);
      return toQueryResult(rows);
    } catch (error) {
      throw toMysqlMigrationError(error, "MySQL query failed", {
        code: "MIGRATION_EXECUTE_FAILED",
        sql,
      });
    }
  }

  #createTransactionExecutor(client: MysqlClient): SqlExecutor {
    const tx: SqlExecutor = {
      execute: <Row = Record<string, unknown>>(
        sql: string,
        params: readonly unknown[] = [],
      ): Promise<QueryResult<Row>> => {
        return this.#executeWithClient<Row>(client, sql, params);
      },

      transaction: <T>(fn: (nestedTx: SqlExecutor) => Promise<T>) => {
        return fn(tx);
      },
    };

    return tx;
  }
}
