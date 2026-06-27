/**
 * libSQL/Turso adapter for `@sisal/orm`.
 *
 * Provides SQLite-dialect query execution over `@libsql/client`, transaction
 * wiring, and a database facade for Turso or local libSQL URLs.
 *
 * @module
 */

import type { Logger } from "@sisal/orm";

import {
  createDatabase,
  type Database,
  type OrmQueryResult,
  type SqlInput,
  type SqlParameter,
} from "@sisal/orm";

import type { LibsqlClient, LibsqlConnectionOptions } from "../client.ts";
import { LIBSQL_DIALECT } from "./dialect.ts";
import { createLibsqlOrmDriver } from "./driver.ts";
import { type LibsqlSqlExecutor, openLibsqlClient } from "./executor.ts";

export {
  createLibsqlClient,
  isLibsqlUrl,
  libsqlConfigFromOptions,
} from "../client.ts";
export type {
  LibsqlArgs,
  LibsqlClient,
  LibsqlClientConfig,
  LibsqlConnectionOptions,
  LibsqlIntMode,
  LibsqlInValue,
  LibsqlResultSet,
  LibsqlStatement,
  LibsqlTransaction,
  LibsqlTransactionMode,
  LibsqlValue,
} from "../client.ts";
export { LIBSQL_DIALECT } from "./dialect.ts";
export { createLibsqlExecutor, openLibsqlClient } from "./executor.ts";
export type {
  LibsqlExecutorOptions,
  LibsqlQueryResult,
  LibsqlSqlExecutor,
} from "./executor.ts";
export { createLibsqlOrmDriver } from "./driver.ts";
export type { LibsqlOrmDriverOptions } from "./driver.ts";

/** libSQL/Turso-specialized database facade. */
export interface LibsqlDatabase extends Database {
  execute<T = unknown>(
    query: SqlInput,
    params?: readonly SqlParameter[],
  ): Promise<OrmQueryResult<T>>;

  query<T = unknown>(
    query: SqlInput,
    params?: readonly SqlParameter[],
  ): Promise<OrmQueryResult<T>>;
}

/** Options for opening a libSQL-backed database facade. */
export interface CreateLibsqlDbOptions extends LibsqlConnectionOptions {
  /** Use an existing libSQL SQL executor instead of opening a client. */
  readonly executor?: LibsqlSqlExecutor;
  readonly logger?: Logger;
}

/** Opens a libSQL/Turso-backed database facade. */
export async function createLibsqlDb(
  options: CreateLibsqlDbOptions,
): Promise<LibsqlDatabase> {
  let client: LibsqlClient | undefined = options.client;
  let ownsClient = false;

  if (options.executor === undefined && client === undefined) {
    client = await openLibsqlClient(options);
    ownsClient = true;
  }

  const driver = createLibsqlOrmDriver({
    executor: options.executor,
    client,
    ownsClient,
  });

  return createDatabase({
    driver,
    dialect: LIBSQL_DIALECT,
    logger: options.logger,
  }) as LibsqlDatabase;
}

/** Convenience alias for {@link createLibsqlDb}. */
export function connect(
  options: CreateLibsqlDbOptions,
): Promise<LibsqlDatabase> {
  return createLibsqlDb(options);
}
