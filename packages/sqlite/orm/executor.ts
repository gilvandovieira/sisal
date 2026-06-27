import { OrmError } from "@sisal/orm";

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

  transaction?<T>(fn: () => Promise<T>): Promise<T>;
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

  constructor(db: SqliteLikeDatabase, ownsDatabase: boolean) {
    this.#db = db;
    this.#ownsDatabase = ownsDatabase;
  }

  execute<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<SqliteQueryResult<Row>> {
    try {
      const statement = this.#db.prepare(sql);

      if (statementReturnsRows(sql)) {
        const rows = statement.all(...params) as Row[];
        return Promise.resolve({ rows, rowCount: rows.length });
      }

      const changes = statement.run(...params);
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
  // BEGIN/COMMIT and rolls back on failure.
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    await this.execute("begin");

    try {
      const result = await fn();
      await this.execute("commit");
      return result;
    } catch (error) {
      try {
        await this.execute("rollback");
      } catch {
        // Preserve the original query/transaction failure.
      }

      throw error;
    }
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
