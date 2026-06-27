import { toPgMigrationError } from "./errors.ts";
import {
  type PgClient,
  type PgConnectionOptions,
  type PgConnectionSource,
  type PgDriverResult,
  resolvePgConnectionSource,
} from "./pool.ts";

/** Rows and affected-row count returned by a PostgreSQL migration executor. */
export interface QueryResult<Row = Record<string, unknown>> {
  readonly rows: Row[];
  readonly rowCount: number;
}

/** Pinned PostgreSQL execution session held across multiple executor calls. */
export interface SqlExecutorSession {
  execute<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;

  release(): Promise<void>;
}

/** Minimal SQL executor used by the PostgreSQL migration adapter. */
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
  readonly client: PgClient;
  release(): void;
}

/** Creates a PostgreSQL SQL executor from an existing executor, pool, client, or URL. */
export function createPgExecutor(
  options: PgConnectionOptions & {
    readonly executor?: SqlExecutor;
  },
): SqlExecutor {
  if (options.executor !== undefined) {
    return options.executor;
  }

  return new SisalPgExecutor(resolvePgConnectionSource(options));
}

class SisalPgExecutor implements SqlExecutor {
  readonly #source: PgConnectionSource;
  readonly #sessions = new Set<AcquiredClient>();
  #closed = false;

  constructor(source: PgConnectionSource) {
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
      const client = await this.#source.pool!.connect();

      return {
        client,
        release() {
          client.release?.();
        },
      };
    } catch (error) {
      throw toPgMigrationError(error, "PostgreSQL connection failed", {
        code: "MIGRATION_CONNECTION_FAILED",
        status: 503,
      });
    }
  }

  async #transactionWithClient<T>(
    client: PgClient,
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
    client: PgClient,
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    try {
      const result: PgDriverResult<Row> = await client.queryObject<Row>(
        sql,
        [...params],
      );

      return {
        rows: result.rows,
        rowCount: result.rowCount ?? result.rows.length,
      };
    } catch (error) {
      throw toPgMigrationError(error, "PostgreSQL query failed", {
        code: "MIGRATION_EXECUTE_FAILED",
        sql,
      });
    }
  }

  #createTransactionExecutor(client: PgClient): SqlExecutor {
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
