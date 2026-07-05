import { normalizeTemporalSqlValue } from "@sisal/orm";

import { toPgOrmError } from "./errors.ts";
import {
  type PgClient,
  type PgConnectionOptions,
  type PgConnectionSource,
  type PgResultColumn,
  resolvePgConnectionSource,
} from "./pool.ts";

/** Rows and affected-row count returned by a PostgreSQL executor. */
export interface PgQueryResult<Row = Record<string, unknown>> {
  /** Row count reported by this pg query result. */
  readonly rows: Row[];
  /** Row count reported by this pg query result. */
  readonly rowCount: number;
}

/** Minimal SQL executor used by the PostgreSQL ORM adapter. */
export interface PgSqlExecutor {
  /** Executes SQL through this pg sql executor. */
  execute<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PgQueryResult<Row>>;
  /** Runs work inside a transaction for this pg sql executor. */

  /** Closes resources held by this pg sql executor. */
  transaction?<T>(fn: (tx: PgSqlExecutor) => Promise<T>): Promise<T>;
  /** Closes resources held by this pg sql executor. */
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

      coercePgColumns(result.rows, result.rowDescription);

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

// `@db/postgres` decodes `float4` (700) / `float8` (701) to strings and
// `int8`/`bigint` (20) to `BigInt`. Coerce floats back to `number` (a
// `columns.doublePrecision()` column reads as the `number` it infers, matching
// the SQLite family) and int8 to `string` so the Postgres family agrees:
// `@sisal/pg` reads `bigint` as a `string`, the same as `@sisal/neon` (v0.9 T7).
// `numeric` (1700) already arrives as a string and stays one for precision.
const PG_FLOAT_OIDS = new Set([700, 701]);
const PG_INT8_OID = 20;

function coercePgColumns(
  rows: readonly unknown[],
  rowDescription:
    | { readonly columns: ReadonlyArray<PgResultColumn> }
    | null
    | undefined,
): void {
  if (rowDescription == null || rows.length === 0) return;
  const floatColumns: string[] = [];
  const int8Columns: string[] = [];
  for (const column of rowDescription.columns) {
    if (PG_FLOAT_OIDS.has(column.typeOid)) floatColumns.push(column.name);
    else if (column.typeOid === PG_INT8_OID) int8Columns.push(column.name);
  }
  if (floatColumns.length === 0 && int8Columns.length === 0) return;

  for (const row of rows as Record<string, unknown>[]) {
    for (const name of floatColumns) {
      const value = row[name];
      if (typeof value === "string" && value.length > 0) {
        row[name] = Number(value);
      }
    }
    for (const name of int8Columns) {
      const value = row[name];
      if (typeof value === "bigint") {
        row[name] = value.toString();
      }
    }
  }
}
