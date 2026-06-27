/**
 * Neon serverless adapter for `@sisal/migrate`.
 *
 * Provides Neon-backed PostgreSQL migration execution by adapting
 * `jsr:@neon/serverless` pools or clients to `@sisal/pg`'s migrator.
 *
 * @module
 */

import type { Logger } from "@sisal/orm";
import {
  createPgMigrator,
  DEFAULT_PG_MIGRATION_TABLE,
  type PgMigrateOptions,
  type PgMigrationDefinition,
  type PgMigrationInput,
  type PgMigrationPlanOptions,
  type PgMigrator,
  type PgRollbackOptions,
} from "@sisal/pg/migrate";

import { createNeonExecutor, type NeonExecutorOptions } from "../executor.ts";

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

/** Default Neon/PostgreSQL table used to store applied migration history. */
export const DEFAULT_NEON_MIGRATION_TABLE = DEFAULT_PG_MIGRATION_TABLE;

/** Neon convenience migration definition with inferred programmatic kind. */
export type NeonMigrationDefinition = PgMigrationDefinition;

/** Migration input accepted by the Neon migrator facade. */
export type NeonMigrationInput = PgMigrationInput;

/** Options for applying pending Neon/PostgreSQL migrations. */
export type NeonMigrateOptions = PgMigrateOptions;

/** Options for rolling back Neon/PostgreSQL migrations. */
export type NeonRollbackOptions = PgRollbackOptions;

/** Options for planning Neon/PostgreSQL migrations without executing them. */
export type NeonMigrationPlanOptions = PgMigrationPlanOptions;

/** Neon migration facade backed by the PostgreSQL migrator. */
export type NeonMigrator = PgMigrator;

/** Options for creating a Neon migration facade. */
export interface CreateNeonMigratorOptions extends NeonExecutorOptions {
  readonly logger?: Logger;
  readonly historyTable?: string;
  readonly useTransaction?: boolean;
}

/** Creates a Neon migration facade with a database-backed history store. */
export async function createNeonMigrator(
  options: CreateNeonMigratorOptions,
): Promise<NeonMigrator> {
  const executor = await createNeonExecutor(options);

  return await createPgMigrator({
    executor,
    logger: options.logger,
    historyTable: options.historyTable,
    useTransaction: options.useTransaction,
  });
}
