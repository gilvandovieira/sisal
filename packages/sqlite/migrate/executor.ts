import { MigrationError } from "@sisal/migrate";

import { toSqliteMigrationError } from "./errors.ts";
import { type SqliteLikeDatabase, statementReturnsRows } from "./database.ts";

/** Rows and affected-row count returned by a SQLite migration executor. */
export interface QueryResult<Row = Record<string, unknown>> {
  readonly rows: Row[];
  readonly rowCount: number;
}

/** Minimal SQL executor used by the SQLite migration adapter. */
export interface SqlExecutor {
  execute<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;

  transaction?<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

/** Options for creating a SQLite SQL executor. */
export interface SqliteExecutorOptions {
  /** Use an existing executor verbatim. */
  readonly executor?: SqlExecutor;
  /** Wrap an already-open database. */
  readonly database?: SqliteLikeDatabase;
  /** Close the database when the executor closes (it owns the handle). */
  readonly ownsDatabase?: boolean;
}

/** Creates a SQLite SQL executor from an existing executor or open database. */
export function createSqliteExecutor(
  options: SqliteExecutorOptions = {},
): SqlExecutor {
  if (options.executor !== undefined) {
    return options.executor;
  }

  if (options.database === undefined) {
    throw new MigrationError("SQLite database is required", {
      code: "MIGRATION_INVALID",
      status: 400,
    });
  }

  return new SisalSqliteExecutor(
    options.database,
    options.ownsDatabase ?? false,
  );
}

class SisalSqliteExecutor implements SqlExecutor {
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
  ): Promise<QueryResult<Row>> {
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
        toSqliteMigrationError(error, "SQLite query failed", {
          code: "MIGRATION_EXECUTE_FAILED",
          sql,
        }),
      );
    }
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    await this.execute("begin");

    try {
      const result = await fn(this);
      await this.execute("commit");
      return result;
    } catch (error) {
      try {
        await this.execute("rollback");
      } catch {
        // Preserve the original migration failure.
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
