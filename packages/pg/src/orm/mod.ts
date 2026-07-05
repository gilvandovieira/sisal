/**
 * PostgreSQL adapter for `@sisal/orm`.
 *
 * Provides PostgreSQL query execution, connection pooling, dialect wiring, and
 * a database facade over `@db/postgres`-compatible clients. URL connections
 * default to the postgres.js driver (`npm:postgres`, lazily imported) since
 * v0.10; pass `driver: "db-postgres"` for the pure-JSR `jsr:@db/postgres`.
 *
 * @module
 */

import type {
  Logger,
  SisalLoggingOptions,
  TemporalParsingOptions,
} from "@sisal/orm";

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
export type {
  PgClient,
  PgConnectionOptions,
  PgDriverKind,
  PgPool,
} from "./pool.ts";
export {
  createPgPool,
  DEFAULT_PG_DRIVER,
  resolvePgDriverKind,
} from "./pool.ts";
export { createPostgresJsPool } from "./postgres_js_pool.ts";
export type { PostgresJsPoolOptions } from "./postgres_js_pool.ts";

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
  readonly logging?: SisalLoggingOptions;
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
      logging: options.logging,
      temporal: options.temporal,
    }) as PgDatabase,
  );
}

/** Convenience alias for {@link createPgDb} — opens a Postgres-backed database. */
export function connect(options: CreatePgDbOptions): Promise<PgDatabase> {
  return createPgDb(options);
}
