/**
 * libSQL/Turso adapter for `@sisal/migrate`.
 *
 * Provides libSQL migration drivers, history stores, migrators, and SQLite
 * DDL-generation aliases for Turso and local libSQL workflows.
 *
 * @module
 */

export { LIBSQL_DIALECT } from "./dialect.ts";

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

export type {
  CreateLibsqlMigratorOptions,
  LibsqlMigrateOptions,
  LibsqlMigrationDefinition,
  LibsqlMigrationInput,
  LibsqlMigrationPlanOptions,
  LibsqlMigrator,
  LibsqlRollbackOptions,
} from "./migrator.ts";
export { createLibsqlMigrator } from "./migrator.ts";

export type {
  LibsqlExecutorOptions,
  QueryResult,
  SqlExecutor,
} from "./executor.ts";
export { createLibsqlExecutor, openLibsqlClient } from "./executor.ts";

export { createLibsqlMigrationDriver } from "./driver.ts";
export type { LibsqlMigrationDriverOptions } from "./driver.ts";

export {
  createLibsqlMigrationHistoryStore,
  DEFAULT_LIBSQL_MIGRATION_TABLE,
} from "./history.ts";
export type { LibsqlMigrationHistoryStoreOptions } from "./history.ts";

export type { LibsqlUpStatements } from "./ddl.ts";
export {
  generateLibsqlAddColumn,
  generateLibsqlColumnDefinition,
  generateLibsqlColumnType,
  generateLibsqlCreateTable,
  generateLibsqlUpStatements,
  quoteLibsqlIdent,
} from "./ddl.ts";
