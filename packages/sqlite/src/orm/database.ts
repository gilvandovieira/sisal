import { hasDenoFfi, openNodeSqlite } from "../native.ts";

/** A prepared statement: `all` returns rows, `run` returns the change count. */
export interface SqliteStatement {
  /** Returns all rows produced by the prepared statement. */
  all(...params: readonly unknown[]): Record<string, unknown>[];
  /** Runs this sqlite statement without returning mapped rows. */
  run(...params: readonly unknown[]): number;
}

/**
 * Minimal SQLite database surface used by the ORM adapter. The bundled
 * `@db/sqlite` `Database` satisfies it structurally, and tests inject a fake.
 */
export interface SqliteLikeDatabase {
  /** Prepares SQL for repeated execution. */
  prepare(sql: string): SqliteStatement;
  /** Closes the underlying SQLite database. */
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
 * Opens a SQLite database with the runtime-native driver, imported lazily (a
 * dynamic import): Deno uses the FFI-backed `@db/sqlite`, Node the built-in
 * `node:sqlite` (see {@link hasDenoFfi}). Merely importing `@sisal/orm/sqlite`
 * — and running the package's fake-backed tests — needs no permissions; only a
 * real Deno open needs `--allow-ffi`/`--allow-env`/`--allow-read` (and
 * `--allow-write` for a file path).
 */
export async function openSqliteDatabase(
  options: SqliteConnectionOptions = {},
): Promise<SqliteLikeDatabase> {
  if (options.database !== undefined) {
    return options.database;
  }

  if (!hasDenoFfi()) {
    return await openNodeSqlite(
      options.path ?? ":memory:",
      options.readonly ?? false,
    ) as unknown as SqliteLikeDatabase;
  }

  // Computed specifier: keeps the Deno-only FFI driver off the static module
  // graph so the npm build (dnt) never pulls it into the Node bundle. The
  // `hasDenoFfi()` guard above ensures we only reach here on Deno, where the
  // import map resolves `@db/sqlite` at runtime.
  const { Database } = await import(["@db", "sqlite"].join("/"));

  return new Database(options.path ?? ":memory:", {
    int64: true,
    readonly: options.readonly ?? false,
  }) as unknown as SqliteLikeDatabase;
}

/**
 * Returns true when a statement yields rows (`SELECT`/`WITH`/`PRAGMA`/`EXPLAIN`,
 * or any statement with a `RETURNING` clause), so the executor knows whether to
 * read rows or report a change count.
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
