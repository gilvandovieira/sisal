import {
  createNeonPool,
  type NeonClient,
  NeonError,
  type NeonPool,
  type NeonPoolConnectionOptions,
  type NeonQueryable,
  type NeonQueryResult,
  normalizeNeonResult,
} from "./client.ts";

/** Rows and affected-row count returned by a Neon executor. */
export interface NeonSqlResult<Row = Record<string, unknown>> {
  readonly rows: Row[];
  readonly rowCount: number;
}

/** Minimal SQL executor used by Sisal's Neon compatibility package. */
export interface NeonSqlExecutor {
  execute<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<NeonSqlResult<Row>>;

  transaction?<T>(fn: (tx: NeonSqlExecutor) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

/** Options for creating a Neon SQL executor. */
export interface NeonExecutorOptions extends NeonPoolConnectionOptions {
  /** Use an existing executor verbatim. */
  readonly executor?: NeonSqlExecutor;
  /** Wrap an already-open Neon pool. */
  readonly pool?: NeonPool;
  /** Wrap an already-open Neon client. */
  readonly client?: NeonClient;
  /** Close the pool when the executor closes. */
  readonly ownsPool?: boolean;
  /** Close the client when the executor closes. */
  readonly ownsClient?: boolean;
}

interface NeonConnectionSource {
  readonly pool?: NeonPool;
  readonly client?: NeonClient;
  readonly ownsPool: boolean;
  readonly ownsClient: boolean;
}

interface AcquiredClient {
  readonly client: NeonClient;
  release(): void;
}

/** Creates a Neon SQL executor from an existing executor, pool, client, or URL. */
export async function createNeonExecutor(
  options: NeonExecutorOptions = {},
): Promise<NeonSqlExecutor> {
  if (options.executor !== undefined) {
    return options.executor;
  }

  return new SisalNeonExecutor(await resolveNeonConnectionSource(options));
}

class SisalNeonExecutor implements NeonSqlExecutor {
  readonly #source: NeonConnectionSource;
  #closed = false;

  constructor(source: NeonConnectionSource) {
    this.#source = source;
  }

  async execute<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<NeonSqlResult<Row>> {
    if (this.#source.client !== undefined) {
      return await this.#executeWithQueryable<Row>(
        this.#source.client,
        sql,
        params,
      );
    }

    return await this.#executeWithQueryable<Row>(
      this.#source.pool!,
      sql,
      params,
    );
  }

  async transaction<T>(fn: (tx: NeonSqlExecutor) => Promise<T>): Promise<T> {
    const acquired = await this.#acquireTransactionClient();
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
          // Preserve the original query/transaction failure.
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

    if (this.#source.ownsPool) {
      await this.#source.pool?.end?.();
    }

    if (this.#source.ownsClient) {
      await this.#source.client?.end?.();
    }
  }

  async #acquireTransactionClient(): Promise<AcquiredClient> {
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
      throw new NeonError("Neon connection failed", {
        code: "NEON_CONNECTION_FAILED",
        cause: error,
      });
    }
  }

  async #executeWithQueryable<Row>(
    queryable: NeonQueryable,
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<NeonSqlResult<Row>> {
    try {
      const result: NeonQueryResult<Row> = await queryable.query<Row>(
        sql,
        [...params],
      );

      return normalizeNeonResult(result);
    } catch (error) {
      throw new NeonError("Neon query failed", {
        code: "NEON_EXECUTE_FAILED",
        details: { sql },
        cause: error,
      });
    }
  }

  #createTransactionExecutor(client: NeonClient): NeonSqlExecutor {
    const tx: NeonSqlExecutor = {
      execute: <Row = Record<string, unknown>>(
        sql: string,
        params: readonly unknown[] = [],
      ): Promise<NeonSqlResult<Row>> => {
        return this.#executeWithQueryable<Row>(client, sql, params);
      },

      transaction: <T>(fn: (nestedTx: NeonSqlExecutor) => Promise<T>) => {
        return fn(tx);
      },
    };

    return tx;
  }
}

async function resolveNeonConnectionSource(
  options: NeonExecutorOptions,
): Promise<NeonConnectionSource> {
  if (options.pool !== undefined && options.client !== undefined) {
    throw new NeonError("Configure either a Neon pool or client, not both", {
      code: "NEON_INVALID",
    });
  }

  if (options.pool !== undefined) {
    return {
      pool: options.pool,
      ownsPool: options.ownsPool ?? false,
      ownsClient: false,
    };
  }

  if (options.client !== undefined) {
    return {
      client: options.client,
      ownsPool: false,
      ownsClient: options.ownsClient ?? false,
    };
  }

  return {
    pool: await createNeonPool(poolOptionsFromExecutorOptions(options)),
    ownsPool: true,
    ownsClient: false,
  };
}

function poolOptionsFromExecutorOptions(
  options: NeonExecutorOptions,
): NeonPoolConnectionOptions {
  const {
    executor: _executor,
    pool: _pool,
    client: _client,
    ownsPool: _ownsPool,
    ownsClient: _ownsClient,
    ...poolOptions
  } = options;

  return poolOptions;
}
