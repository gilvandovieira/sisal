import { normalizeTemporalSqlValue, OrmError } from "@sisal/orm";

import { toSqliteOrmError } from "./errors.ts";
import { type SqliteLikeDatabase, statementReturnsRows } from "./database.ts";

/** Rows and affected-row count returned by a SQLite executor. */
export interface SqliteQueryResult<Row = Record<string, unknown>> {
  readonly rows: Row[];
  readonly rowCount: number;
}

/** Minimal SQL executor used by the SQLite ORM adapter. */
export interface SqliteSqlExecutor {
  execute<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<SqliteQueryResult<Row>>;

  transaction?<T>(fn: (tx: SqliteSqlExecutor) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

/** Options for creating a SQLite SQL executor. */
export interface SqliteExecutorOptions {
  /** Use an existing executor verbatim. */
  readonly executor?: SqliteSqlExecutor;
  /** Wrap an already-open database. */
  readonly database?: SqliteLikeDatabase;
  /** Close the database when the executor closes (it owns the handle). */
  readonly ownsDatabase?: boolean;
}

/** Creates a SQLite SQL executor from an existing executor or open database. */
export function createSqliteExecutor(
  options: SqliteExecutorOptions = {},
): SqliteSqlExecutor {
  if (options.executor !== undefined) {
    return options.executor;
  }

  if (options.database === undefined) {
    throw new OrmError("SQLite database is required", {
      code: "ORM_DRIVER_MISSING",
      status: 400,
    });
  }

  return new SisalSqliteExecutor(
    options.database,
    options.ownsDatabase ?? false,
  );
}

class SisalSqliteExecutor implements SqliteSqlExecutor {
  readonly #db: SqliteLikeDatabase;
  readonly #ownsDatabase: boolean;
  #closed = false;
  // Promise-chain mutex. SQLite is single-connection, so every `execute` and
  // every `transaction` runs as one serialized unit on this tail. While a
  // transaction's BEGIN…COMMIT slot is held, any other `execute`/`transaction`
  // on this same facade queues behind it instead of leaking into the open
  // transaction.
  #tail: Promise<unknown> = Promise.resolve();

  constructor(db: SqliteLikeDatabase, ownsDatabase: boolean) {
    this.#db = db;
    this.#ownsDatabase = ownsDatabase;
  }

  // Appends `work` to the serialization tail and returns its result. The tail
  // swallows errors so one failed unit never blocks the queue, while callers
  // still observe the original rejection.
  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work, work);
    this.#tail = result.then(() => {}, () => {});
    return result;
  }

  execute<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<SqliteQueryResult<Row>> {
    return this.#enqueue(() => this.#runStatement<Row>(sql, params));
  }

  // Runs one prepared statement directly, without touching the queue. Only call
  // this from inside a held serialization slot (an `execute`/`transaction`).
  #runStatement<Row>(
    sql: string,
    params: readonly unknown[],
  ): Promise<SqliteQueryResult<Row>> {
    try {
      const statement = this.#db.prepare(sql);
      const normalizedParams = params.map(normalizeTemporalSqlValue);

      if (statementReturnsRows(sql)) {
        const rows = statement.all(...normalizedParams) as Row[];
        return Promise.resolve({ rows, rowCount: rows.length });
      }

      const changes = statement.run(...normalizedParams);
      return Promise.resolve({
        rows: [],
        rowCount: typeof changes === "number" ? changes : 0,
      });
    } catch (error) {
      return Promise.reject(
        toSqliteOrmError(error, "SQLite query failed", {
          code: "ORM_EXECUTE_FAILED",
          sql,
        }),
      );
    }
  }

  // SQLite is single-connection, so a transaction wraps the same database in
  // BEGIN/COMMIT and rolls back on failure. The whole BEGIN…COMMIT runs in one
  // serialization slot, and the callback receives a scoped executor whose calls
  // run inside that held slot — so the transaction owns the connection
  // exclusively for its duration. The scoped executor deliberately omits
  // `transaction`, so a nested transaction runs inline (SQLite cannot nest
  // BEGINs) rather than deadlocking on the held slot.
  transaction<T>(
    fn: (tx: SqliteSqlExecutor) => Promise<T>,
  ): Promise<T> {
    return this.#enqueue(async () => {
      const tx: SqliteSqlExecutor = {
        execute: <Row = Record<string, unknown>>(
          sql: string,
          params: readonly unknown[] = [],
        ): Promise<SqliteQueryResult<Row>> =>
          this.#runStatement<Row>(sql, params),
      };

      await this.#runStatement("begin", []);

      try {
        const result = await fn(tx);
        await this.#runStatement("commit", []);
        return result;
      } catch (error) {
        try {
          await this.#runStatement("rollback", []);
        } catch {
          // Preserve the original query/transaction failure.
        }

        throw error;
      }
    });
  }

  close(): Promise<void> {
    if (this.#closed) {
      return Promise.resolve();
    }

    this.#closed = true;

    if (this.#ownsDatabase) {
      this.#db.close();
    }

    return Promise.resolve();
  }
}
