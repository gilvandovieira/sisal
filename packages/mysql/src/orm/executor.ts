import { normalizeTemporalSqlValue } from "@sisal/orm";

import { toMysqlOrmError } from "./errors.ts";
import {
  type MysqlClient,
  type MysqlConnectionOptions,
  type MysqlConnectionSource,
  type MysqlDriverRows,
  resolveMysqlConnectionSource,
} from "./pool.ts";

/** Rows and affected-row count returned by a MySQL executor. */
export interface MysqlQueryResult<Row = Record<string, unknown>> {
  /** Row count reported by this mysql query result. */
  readonly rows: Row[];
  /** Row count reported by this mysql query result. */
  readonly rowCount: number;
  /**
   * `LAST_INSERT_ID` reported for a write statement — the first
   * `AUTO_INCREMENT` id the statement generated, absent when it generated
   * none. Feeds the B7 `insertReturning` fetch-by-key fallback.
   */
  readonly insertId?: number | string;
}

/** Minimal SQL executor used by the MySQL ORM adapter. */
export interface MysqlSqlExecutor {
  /** Executes SQL through this mysql sql executor. */
  execute<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<MysqlQueryResult<Row>>;
  /** Runs work inside a transaction for this mysql sql executor. */

  /** Closes resources held by this mysql sql executor. */
  transaction?<T>(fn: (tx: MysqlSqlExecutor) => Promise<T>): Promise<T>;
  /** Closes resources held by this mysql sql executor. */
  close?(): Promise<void>;
}

interface AcquiredClient {
  readonly client: MysqlClient;
  release(): void;
}

/** Creates a MySQL SQL executor from an existing executor, pool, client, or URL. */
export function createMysqlExecutor(
  options: MysqlConnectionOptions & {
    readonly executor?: MysqlSqlExecutor;
  },
): MysqlSqlExecutor {
  if (options.executor !== undefined) {
    return options.executor;
  }

  return new SisalMysqlExecutor(resolveMysqlConnectionSource(options));
}

class SisalMysqlExecutor implements MysqlSqlExecutor {
  readonly #source: MysqlConnectionSource;
  #closed = false;

  constructor(source: MysqlConnectionSource) {
    this.#source = source;
  }

  async execute<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<MysqlQueryResult<Row>> {
    const acquired = await this.#acquireClient();

    try {
      return await this.#executeWithClient<Row>(acquired.client, sql, params);
    } finally {
      acquired.release();
    }
  }

  async transaction<T>(fn: (tx: MysqlSqlExecutor) => Promise<T>): Promise<T> {
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
          // Preserve the original failure.
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
      const client = await this.#source.pool!.getConnection();

      return {
        client,
        release() {
          client.release?.();
        },
      };
    } catch (error) {
      throw toMysqlOrmError(error, "MySQL connection failed", {
        code: "ORM_CONNECTION_FAILED",
        status: 503,
      });
    }
  }

  async #executeWithClient<Row>(
    client: MysqlClient,
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<MysqlQueryResult<Row>> {
    try {
      const [rows] = await client.query<Row>(sql, normalizeParams(params));
      return mapDriverRows<Row>(rows);
    } catch (error) {
      throw toMysqlOrmError(error, "MySQL query failed", {
        code: "ORM_EXECUTE_FAILED",
        sql,
      });
    }
  }

  #createTransactionExecutor(client: MysqlClient): MysqlSqlExecutor {
    const tx: MysqlSqlExecutor = {
      execute: <Row = Record<string, unknown>>(
        sql: string,
        params: readonly unknown[] = [],
      ): Promise<MysqlQueryResult<Row>> => {
        return this.#executeWithClient<Row>(client, sql, params);
      },

      transaction: <T>(fn: (nestedTx: MysqlSqlExecutor) => Promise<T>) => {
        return fn(tx);
      },
    };

    return tx;
  }
}

// mysql2 resolves `[rows, fields]` where `rows` is an array for reads and an
// affected-rows header for writes; normalize both to the executor contract.
function mapDriverRows<Row>(
  rows: MysqlDriverRows<Row>,
): MysqlQueryResult<Row> {
  if (Array.isArray(rows)) {
    normalizeBinaryValues(rows as Record<string, unknown>[]);
    return { rows, rowCount: rows.length };
  }
  return {
    rows: [],
    rowCount: rows.affectedRows,
    // 0 means "no AUTO_INCREMENT id generated" — normalize it to absent.
    // The mariadb connector reports a bigint; re-view it as a string, the
    // same precision-safe shape the mandated decode options give BIGINT
    // columns.
    ...(rows.insertId === undefined || rows.insertId === 0 ||
        rows.insertId === 0n || rows.insertId === "0"
      ? {}
      : {
        insertId: typeof rows.insertId === "bigint"
          ? rows.insertId.toString()
          : rows.insertId,
      }),
  };
}

// Both drivers decode BLOB columns to Node `Buffer`s; re-view them as plain
// `Uint8Array`s so binary round-trips match the other adapters' value shape
// (`columns.bytea()` infers `Uint8Array`). A view, not a copy — and only
// Buffer-like values are touched, so text columns are unaffected.
function normalizeBinaryValues(rows: Record<string, unknown>[]): void {
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    for (const key of Object.keys(row)) {
      const value = row[key];
      if (
        value instanceof Uint8Array && value.constructor !== Uint8Array
      ) {
        row[key] = new Uint8Array(
          value.buffer,
          value.byteOffset,
          value.byteLength,
        );
      }
    }
  }
}

function normalizeParams(params: readonly unknown[]): unknown[] {
  return params.map((param) => {
    const value = normalizeTemporalSqlValue(param);
    if (typeof value === "string" && value !== (param as unknown)) {
      // The param was a Temporal value; make its serialized literal
      // MySQL-safe (MySQL rejects a trailing `Z`/offset designator).
      return mysqlTemporalLiteral(value);
    }
    if (value === null || typeof value !== "object") {
      return value;
    }
    if (value instanceof Date) {
      // The executor UTC convention (C4): instants are written as naive UTC
      // literals — deterministic bytes, independent of the client timezone
      // the driver would otherwise bake in.
      return utcNaiveLiteral(value.toISOString());
    }
    if (value instanceof Uint8Array) {
      return value;
    }
    // Plain objects and arrays serialize to JSON text (the `JSON`-mapped
    // column value shape). Passing them through raw is dangerous with
    // mysql2's text protocol: an object interpolates as invalid SQL and an
    // array EXPANDS into one value per element, silently shifting every
    // later placeholder.
    return JSON.stringify(value);
  });
}

// `Temporal.Instant`/`ZonedDateTime` serialize with a `Z` suffix, which
// MySQL rejects as a datetime literal — re-render them as naive UTC. Plain
// (naive) forms pass through; MySQL accepts the `T` delimiter.
function mysqlTemporalLiteral(value: string): string {
  if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/u.test(value)) {
    return utcNaiveLiteral(
      Temporal.Instant.from(value).toString({ fractionalSecondDigits: 6 }),
    );
  }
  return value;
}

function utcNaiveLiteral(isoUtc: string): string {
  return isoUtc.replace(/[zZ]$/u, "").replace("T", " ");
}
