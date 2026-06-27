/**
 * PostgreSQL adapter for `@sisal/migrate`.
 *
 * Provides PostgreSQL migration drivers, history stores, advisory-lock-backed
 * migrators, connection pooling, and additive DDL generation helpers.
 *
 * @module
 */

export type {
  PgMigrateOptions,
  PgMigrationDefinition,
  PgMigrationInput,
  PgMigrationPlanOptions,
  PgMigrator,
  PgRollbackOptions,
} from "./migrator.ts";
export { createPgMigrator } from "./migrator.ts";

export type { QueryResult, SqlExecutor } from "./executor.ts";
export { createPgExecutor } from "./executor.ts";

export { createPgMigrationDriver } from "./driver.ts";
export type { PgMigrationDriverOptions } from "./driver.ts";

export {
  createPgMigrationHistoryStore,
  DEFAULT_PG_MIGRATION_TABLE,
} from "./history.ts";
export type { PgMigrationHistoryStoreOptions } from "./history.ts";

export type { PgClient, PgConnectionOptions, PgPool } from "./pool.ts";
export { createPgPool } from "./pool.ts";

export type { PostgresUpStatements } from "./ddl.ts";
export {
  generatePostgresAddColumn,
  generatePostgresColumnDefinition,
  generatePostgresColumnType,
  generatePostgresCreateTable,
  generatePostgresUpStatements,
  pgQualifiedName,
  quotePgIdent,
} from "./ddl.ts";
