import { normalizeTemporalSqlValue } from "@sisal/orm";

import { toPgOrmError } from "./errors.ts";
import {
  type PgClient,
  type PgConnectionOptions,
  type PgConnectionSource,
  resolvePgConnectionSource,
} from "./pool.ts";

/** Rows and affected-row count returned by a PostgreSQL executor. */
export interface PgQueryResult<Row = Record<string, unknown>> {
  readonly rows: Row[];
  readonly rowCount: number;
}

/** Minimal SQL executor used by the PostgreSQL ORM adapter. */
export interface PgSqlExecutor {
  execute<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PgQueryResult<Row>>;

  transaction?<T>(fn: (tx: PgSqlExecutor) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

interface AcquiredClient {
  readonly client: PgClient;
  release(): void;
}

/** Creates a PostgreSQL SQL executor from an existing executor, pool, client, or URL. */
export function createPgExecutor(
  options: PgConnectionOptions & {
    readonly executor?: PgSqlExecutor;
  },
): PgSqlExecutor {
  if (options.executor !== undefined) {
    return options.executor;
  }

  return new SisalPgExecutor(resolvePgConnectionSource(options));
}

class SisalPgExecutor implements PgSqlExecutor {
  readonly #source: PgConnectionSource;
  #closed = false;

  constructor(source: PgConnectionSource) {
    this.#source = source;
  }

  async execute<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    const acquired = await this.#acquireClient();

    try {
      return await this.#executeWithClient<Row>(acquired.client, sql, params);
    } finally {
      acquired.release();
    }
  }

  async transaction<T>(fn: (tx: PgSqlExecutor) => Promise<T>): Promise<T> {
    const acquired = await this.#acquireClient();
    const tx = this.#createTransactionExecutor(acquired.client);

    try {
      await tx.execute("begin");

      try {
        const result = await fn(tx);
        await tx.execute("commit");
        return result;
      } catch (error) {
        try {
          await tx.execute("rollback");
        } catch {
          // Preserve the original migration/query failure.
        }

        throw error;
      }
    } finally {
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
      throw toPgOrmError(error, "PostgreSQL connection failed", {
        code: "ORM_CONNECTION_FAILED",
        status: 503,
      });
    }
  }

  async #executeWithClient<Row>(
    client: PgClient,
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    try {
      const result = await client.queryObject<Row>(
        sql,
        normalizeParams(params),
      );

      return {
        rows: result.rows,
        rowCount: result.rowCount ?? result.rows.length,
      };
    } catch (error) {
      throw toPgOrmError(error, "PostgreSQL query failed", {
        code: "ORM_EXECUTE_FAILED",
        sql,
      });
    }
  }

  #createTransactionExecutor(client: PgClient): PgSqlExecutor {
    const tx: PgSqlExecutor = {
      execute: <Row = Record<string, unknown>>(
        sql: string,
        params: readonly unknown[] = [],
      ): Promise<PgQueryResult<Row>> => {
        return this.#executeWithClient<Row>(client, sql, params);
      },

      transaction: <T>(fn: (nestedTx: PgSqlExecutor) => Promise<T>) => {
        return fn(tx);
      },
    };

    return tx;
  }
}

function normalizeParams(params: readonly unknown[]): unknown[] {
  return params.map(normalizeTemporalSqlValue);
}
