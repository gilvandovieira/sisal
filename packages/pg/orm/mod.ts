/**
 * PostgreSQL adapter for `@sisal/orm`.
 *
 * Provides PostgreSQL query execution, connection pooling, dialect wiring, and
 * a database facade backed by `@db/postgres`-compatible clients.
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

import { POSTGRES_DIALECT } from "./dialect.ts";
import { createPgOrmDriver, type PgOrmDriverOptions } from "./driver.ts";

export type { PgQueryResult, PgSqlExecutor } from "./executor.ts";
export { createPgExecutor } from "./executor.ts";
export { POSTGRES_DIALECT } from "./dialect.ts";
export { createPgOrmDriver } from "./driver.ts";
export type { PgOrmDriverOptions } from "./driver.ts";
export type { PgClient, PgConnectionOptions, PgPool } from "./pool.ts";
export { createPgPool } from "./pool.ts";

/** PostgreSQL-specialized database facade. */
export interface PgDatabase extends Database {
  execute<T = unknown>(
    query: SqlInput,
    params?: readonly SqlParameter[],
  ): Promise<OrmQueryResult<T>>;

  query<T = unknown>(
    query: SqlInput,
    params?: readonly SqlParameter[],
  ): MappableQueryResult<T>;
}

/** Options for opening a PostgreSQL-backed database facade. */
export interface CreatePgDbOptions extends PgOrmDriverOptions {
  readonly logger?: Logger;
  readonly temporal?: TemporalParsingOptions;
}

/** Opens a PostgreSQL-backed database facade. */
export function createPgDb(
  options: CreatePgDbOptions,
): Promise<PgDatabase> {
  const driver = createPgOrmDriver(options);

  return Promise.resolve(
    createDatabase({
      driver,
      dialect: POSTGRES_DIALECT,
      logger: options.logger,
      temporal: options.temporal,
    }) as PgDatabase,
  );
}

/** Convenience alias for {@link createPgDb} — opens a Postgres-backed database. */
export function connect(options: CreatePgDbOptions): Promise<PgDatabase> {
  return createPgDb(options);
}
