/**
 * SQLite adapter for `@sisal/orm`.
 *
 * Provides SQLite query execution, lazy `@db/sqlite` database opening, dialect
 * wiring, column affinity helpers, and a database facade.
 *
 * @module
 */

import type { Logger, TemporalParsingOptions } from "@sisal/orm";

import {
  createDatabase,
  type Database,
  type MappableQueryResult,
  type OrmQueryResult,
  type SqlInput,
  type SqlParameter,
} from "@sisal/orm";

import { SQLITE_DIALECT } from "./dialect.ts";
import {
  openSqliteDatabase,
  type SqliteConnectionOptions,
  type SqliteLikeDatabase,
} from "./database.ts";
import { createSqliteOrmDriver } from "./driver.ts";

export { SQLITE_DIALECT, sqliteColumnAffinity } from "./dialect.ts";
export type {
  SqliteConnectionOptions,
  SqliteLikeDatabase,
  SqliteStatement,
} from "./database.ts";
export { openSqliteDatabase, statementReturnsRows } from "./database.ts";
export type {
  SqliteExecutorOptions,
  SqliteQueryResult,
  SqliteSqlExecutor,
} from "./executor.ts";
export { createSqliteExecutor } from "./executor.ts";
export { createSqliteOrmDriver } from "./driver.ts";
export type { SqliteOrmDriverOptions } from "./driver.ts";

/** SQLite-specialized database facade. */
export interface SqliteDatabase extends Database {
  execute<T = unknown>(
    query: SqlInput,
    params?: readonly SqlParameter[],
  ): Promise<OrmQueryResult<T>>;

  query<T = unknown>(
    query: SqlInput,
    params?: readonly SqlParameter[],
  ): MappableQueryResult<T>;
}

/** Options for opening a SQLite-backed database facade. */
export interface CreateSqliteDbOptions extends SqliteConnectionOptions {
  /** Use an existing SQLite SQL executor instead of opening a database. */
  readonly executor?: import("./executor.ts").SqliteSqlExecutor;
  readonly logger?: Logger;
  readonly temporal?: TemporalParsingOptions;
}

/** Opens a SQLite-backed database facade. */
export async function createSqliteDb(
  options: CreateSqliteDbOptions = {},
): Promise<SqliteDatabase> {
  let database: SqliteLikeDatabase | undefined = options.database;
  let ownsDatabase = false;

  // Only open a real `@db/sqlite` handle (FFI, needs permissions) when neither
  // an executor nor an open database was injected.
  if (options.executor === undefined && database === undefined) {
    database = await openSqliteDatabase(options);
    ownsDatabase = true;
  }

  const driver = createSqliteOrmDriver({
    executor: options.executor,
    database,
    ownsDatabase,
  });

  return createDatabase({
    driver,
    dialect: SQLITE_DIALECT,
    logger: options.logger,
    temporal: options.temporal,
  }) as SqliteDatabase;
}

/** Convenience alias for {@link createSqliteDb} — opens a SQLite-backed database. */
export function connect(
  options: CreateSqliteDbOptions = {},
): Promise<SqliteDatabase> {
  return createSqliteDb(options);
}
