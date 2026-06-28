import { MigrationError } from "@sisal/migrate";
import { normalizeTemporalSqlValue } from "@sisal/orm";

import {
  createLibsqlClient,
  type LibsqlClient,
  libsqlConfigFromOptions,
  type LibsqlConnectionOptions,
  type LibsqlInValue,
  type LibsqlResultSet,
  type LibsqlTransaction,
} from "../client.ts";
import { toLibsqlMigrationError } from "./errors.ts";

/** Rows and affected-row count returned by a libSQL migration executor. */
export interface QueryResult<Row = Record<string, unknown>> {
  readonly rows: Row[];
  readonly rowCount: number;
}

/** Minimal SQL executor used by the libSQL migration adapter. */
export interface SqlExecutor {
  execute<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;

  transaction?<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

/** Options for creating a libSQL SQL executor. */
export interface LibsqlExecutorOptions {
  /** Use an existing executor verbatim. */
  readonly executor?: SqlExecutor;
  /** Wrap an already-open libSQL client. */
  readonly client?: LibsqlClient;
  /** Close the client when the executor closes (it owns the handle). */
  readonly ownsClient?: boolean;
}

/** Opens a libSQL/Turso client for migration use. */
export async function openLibsqlClient(
  options: LibsqlConnectionOptions,
): Promise<LibsqlClient> {
  if (options.client !== undefined) {
    return options.client;
  }

  const config = libsqlConfigFromOptions(options);
  if (config === undefined) {
    throw new MigrationError("libSQL connection url is required", {
      code: "MIGRATION_DRIVER_MISSING",
      status: 400,
    });
  }

  try {
    return await createLibsqlClient(config);
  } catch (error) {
    throw toLibsqlMigrationError(error, "libSQL connection failed", {
      code: "MIGRATION_CONNECTION_FAILED",
      status: 503,
    });
  }
}

/** Creates a libSQL SQL executor from an existing executor or open client. */
export function createLibsqlExecutor(
  options: LibsqlExecutorOptions = {},
): SqlExecutor {
  if (options.executor !== undefined) {
    return options.executor;
  }

  if (options.client === undefined) {
    throw new MigrationError("libSQL client is required", {
      code: "MIGRATION_DRIVER_MISSING",
      status: 400,
    });
  }

  return new SisalLibsqlExecutor(
    options.client,
    options.ownsClient ?? false,
  );
}

class SisalLibsqlExecutor implements SqlExecutor {
  readonly #client: LibsqlClient;
  readonly #ownsClient: boolean;
  #closed = false;

  constructor(client: LibsqlClient, ownsClient: boolean) {
    this.#client = client;
    this.#ownsClient = ownsClient;
  }

  async execute<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    return await this.#executeWithClient<Row>(this.#client, sql, params);
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    if (this.#client.transaction === undefined) {
      return await fn(this);
    }

    const transaction = await this.#client.transaction("write");
    const tx = this.#createTransactionExecutor(transaction);

    try {
      const result = await fn(tx);
      await transaction.commit();
      return result;
    } catch (error) {
      try {
        await transaction.rollback();
      } catch {
        // Preserve the original migration failure.
      }

      throw error;
    } finally {
      transaction.close();
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }

    this.#closed = true;

    if (this.#ownsClient) {
      await this.#client.close?.();
    }
  }

  async #executeWithClient<Row>(
    client: LibsqlClient,
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    try {
      const statement = { sql, args: normalizeLibsqlParams(params) };
      const result = await client.execute<Row>(statement);
      return libsqlResultToQueryResult(result);
    } catch (error) {
      throw toLibsqlMigrationError(error, "libSQL query failed", {
        code: "MIGRATION_EXECUTE_FAILED",
        sql,
      });
    }
  }

  async #executeWithTransaction<Row>(
    transaction: LibsqlTransaction,
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    try {
      const statement = { sql, args: normalizeLibsqlParams(params) };
      const result: LibsqlResultSet<Row> = await transaction.execute<Row>(
        statement,
      );
      return libsqlResultToQueryResult(result);
    } catch (error) {
      throw toLibsqlMigrationError(error, "libSQL query failed", {
        code: "MIGRATION_EXECUTE_FAILED",
        sql,
      });
    }
  }

  #createTransactionExecutor(transaction: LibsqlTransaction): SqlExecutor {
    const tx: SqlExecutor = {
      execute: <Row = Record<string, unknown>>(
        sql: string,
        params: readonly unknown[] = [],
      ): Promise<QueryResult<Row>> => {
        return this.#executeWithTransaction<Row>(transaction, sql, params);
      },

      transaction: <T>(fn: (nestedTx: SqlExecutor) => Promise<T>) => {
        return fn(tx);
      },
    };

    return tx;
  }
}

function libsqlResultToQueryResult<Row>(
  result: LibsqlResultSet<Row>,
): QueryResult<Row> {
  return {
    rows: result.rows,
    rowCount: result.rowsAffected ?? result.rows.length,
  };
}

function normalizeLibsqlParams(params: readonly unknown[]): LibsqlInValue[] {
  return params.map(normalizeLibsqlParam);
}

function normalizeLibsqlParam(value: unknown): LibsqlInValue {
  const normalized = normalizeTemporalSqlValue(value);
  if (normalized !== value) {
    return normalizeLibsqlParam(normalized);
  }

  if (value === undefined) {
    return null;
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean" ||
    value instanceof Date ||
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer
  ) {
    return value;
  }

  if (Array.isArray(value) || isRecord(value)) {
    return JSON.stringify(value);
  }

  throw new MigrationError("libSQL parameter is not serializable", {
    code: "MIGRATION_INVALID",
    details: { type: typeof value },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
