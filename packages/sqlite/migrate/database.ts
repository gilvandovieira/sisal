/** A prepared statement: `all` returns rows, `run` returns the change count. */
export interface SqliteStatement {
  all(...params: readonly unknown[]): Record<string, unknown>[];
  run(...params: readonly unknown[]): number;
}

/**
 * Minimal SQLite database surface used by the migration adapter. The bundled
 * `@db/sqlite` `Database` satisfies it structurally, and tests inject a fake.
 */
export interface SqliteLikeDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

/** Options for opening a SQLite database. */
export interface SqliteConnectionOptions {
  /** File path (`:memory:` for an in-memory database). Defaults to `:memory:`. */
  readonly path?: string;
  /** An already-open SQLite database to use instead of opening one. */
  readonly database?: SqliteLikeDatabase;
  /** Open the database read-only. */
  readonly readonly?: boolean;
}

/**
 * Opens a SQLite database with the bundled `@db/sqlite` driver. The driver is
 * imported lazily, so importing `@sisal/migrate/sqlite` — and running its
 * fake-backed tests — needs no permissions; only a real open needs
 * `--allow-ffi`/`--allow-env`/`--allow-read` (and `--allow-write` for a path).
 */
export async function openSqliteDatabase(
  options: SqliteConnectionOptions = {},
): Promise<SqliteLikeDatabase> {
  if (options.database !== undefined) {
    return options.database;
  }

  // deno-lint-ignore no-import-prefix
  const { Database } = await import("jsr:@db/sqlite@^0.12");

  return new Database(options.path ?? ":memory:", {
    readonly: options.readonly ?? false,
  }) as unknown as SqliteLikeDatabase;
}

/**
 * Returns true when a statement yields rows (`SELECT`/`WITH`/`PRAGMA`/`EXPLAIN`,
 * or any statement with a `RETURNING` clause).
 */
export function statementReturnsRows(sql: string): boolean {
  const head = sql.replace(/^[\s(]+/, "").slice(0, 8).toLowerCase();

  if (
    head.startsWith("select") || head.startsWith("with") ||
    head.startsWith("pragma") || head.startsWith("explain")
  ) {
    return true;
  }

  return /\breturning\b/i.test(sql);
}
