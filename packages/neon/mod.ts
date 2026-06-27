/**
 * Neon serverless adapter package for Sisal.
 *
 * The root export provides the most common Neon ORM and migration helpers.
 * Import `@sisal/neon/orm`, `@sisal/neon/migrate`, or `@sisal/neon/ddl`
 * when a narrower boundary is better for an application.
 *
 * @module
 */

export {
  connect,
  createNeonClient,
  createNeonDb,
  createNeonExecutor,
  createNeonPool,
  neonClientConfigFromOptions,
  NeonError,
  neonPoolConfigFromOptions,
  normalizeNeonResult,
  POSTGRES_DIALECT,
  resolveNeonConnectionString,
} from "./orm/mod.ts";
export type {
  CreateNeonDbOptions,
  NeonClient,
  NeonClientConfig,
  NeonClientConnectionOptions,
  NeonDatabase,
  NeonDriverQueryResult,
  NeonErrorCode,
  NeonExecutorOptions,
  NeonPool,
  NeonPoolConfig,
  NeonPoolConnectionOptions,
  NeonQueryable,
  NeonQueryResult,
  NeonQueryResultRow,
  NeonSqlExecutor,
  NeonSqlResult,
} from "./orm/mod.ts";

export {
  createNeonMigrator,
  DEFAULT_NEON_MIGRATION_TABLE,
} from "./migrate/mod.ts";
export type {
  CreateNeonMigratorOptions,
  NeonMigrateOptions,
  NeonMigrationDefinition,
  NeonMigrationInput,
  NeonMigrationPlanOptions,
  NeonMigrator,
  NeonRollbackOptions,
} from "./migrate/mod.ts";

export {
  generatePostgresAddColumn,
  generatePostgresColumnDefinition,
  generatePostgresColumnType,
  generatePostgresCreateTable,
  generatePostgresUpStatements,
  pgQualifiedName,
  quotePgIdent,
} from "./ddl.ts";
export type { PostgresUpStatements } from "./ddl.ts";
