/**
 * Neon serverless adapter for `@sisal/orm`.
 *
 * Provides PostgreSQL-dialect query execution through
 * `jsr:@neon/serverless` pools or clients, plus a database facade compatible
 * with Sisal's Postgres ORM driver.
 *
 * @module
 */

import type { Logger, TemporalParsingOptions } from "@sisal/orm";

import {
  createDatabase,
  type Database,
  type OrmQueryResult,
  type SqlInput,
  type SqlParameter,
} from "@sisal/orm";
import { createPgOrmDriver, POSTGRES_DIALECT } from "@sisal/pg/orm";

import {
  createNeonExecutor,
  type NeonExecutorOptions,
  type NeonSqlExecutor,
} from "../executor.ts";

export {
  createNeonClient,
  createNeonPool,
  neonClientConfigFromOptions,
  neonPoolConfigFromOptions,
  normalizeNeonResult,
  resolveNeonConnectionString,
} from "../client.ts";
export type {
  NeonClient,
  NeonClientConfig,
  NeonClientConnectionOptions,
  NeonDriverQueryResult,
  NeonErrorCode,
  NeonPool,
  NeonPoolConfig,
  NeonPoolConnectionOptions,
  NeonQueryable,
  NeonQueryResult,
  NeonQueryResultRow,
} from "../client.ts";
export { NeonError } from "../client.ts";
export { createNeonExecutor } from "../executor.ts";
export type {
  NeonExecutorOptions,
  NeonSqlExecutor,
  NeonSqlResult,
} from "../executor.ts";
export { POSTGRES_DIALECT } from "@sisal/pg/orm";

/** Neon-specialized database facade. */
export interface NeonDatabase extends Database {
  execute<T = unknown>(
    query: SqlInput,
    params?: readonly SqlParameter[],
  ): Promise<OrmQueryResult<T>>;

  query<T = unknown>(
    query: SqlInput,
    params?: readonly SqlParameter[],
  ): Promise<OrmQueryResult<T>>;
}

/** Options for opening a Neon-backed database facade. */
export interface CreateNeonDbOptions extends NeonExecutorOptions {
  readonly logger?: Logger;
  readonly temporal?: TemporalParsingOptions;
}

/** Opens a Neon-backed PostgreSQL database facade. */
export async function createNeonDb(
  options: CreateNeonDbOptions,
): Promise<NeonDatabase> {
  const executor: NeonSqlExecutor = await createNeonExecutor(options);
  const driver = createPgOrmDriver({ executor });

  return createDatabase({
    driver,
    dialect: POSTGRES_DIALECT,
    logger: options.logger,
    temporal: options.temporal,
  }) as NeonDatabase;
}

/** Convenience alias for {@link createNeonDb}. */
export function connect(
  options: CreateNeonDbOptions,
): Promise<NeonDatabase> {
  return createNeonDb(options);
}
