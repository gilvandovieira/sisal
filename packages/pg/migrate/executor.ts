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

/** Minimal SQL executor used by the PostgreSQL migration adapter. */
export interface SqlExecutor {
  execute<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;

  transaction?<T>(fn: () => Promise<T>): Promise<T>;
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
  #transactionClient?: PgClient;
  #closed = false;

  constructor(source: PgConnectionSource) {
    this.#source = source;
  }

  async execute<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    if (this.#transactionClient !== undefined) {
      return await this.#executeWithClient<Row>(
        this.#transactionClient,
        sql,
        params,
      );
    }

    const acquired = await this.#acquireClient();

    try {
      return await this.#executeWithClient<Row>(acquired.client, sql, params);
    } finally {
      acquired.release();
    }
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#transactionClient !== undefined) {
      return await fn();
    }

    const acquired = await this.#acquireClient();

    try {
      this.#transactionClient = acquired.client;
      await this.#executeWithClient(acquired.client, "begin");

      try {
        const result = await fn();
        await this.#executeWithClient(acquired.client, "commit");
        return result;
      } catch (error) {
        try {
          await this.#executeWithClient(acquired.client, "rollback");
        } catch {
          // Preserve the original migration failure.
        }

        throw error;
      }
    } finally {
      this.#transactionClient = undefined;
      acquired.release();
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }

    this.#closed = true;

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
}
