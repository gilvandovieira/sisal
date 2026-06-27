import type { SqlParameter } from "@sisal/orm";

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
  #transactionClient?: PgClient;
  #closed = false;

  constructor(source: PgConnectionSource) {
    this.#source = source;
  }

  async execute<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
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
          // Preserve the original migration/query failure.
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
}

function normalizeParams(params: readonly unknown[]): SqlParameter[] {
  return params.map((param) => param as SqlParameter);
}
