/**
 * libSQL/Turso adapter package for Sisal.
 *
 * The root export provides the most common libSQL ORM and migration helpers.
 * Import `@sisal/libsql/orm` or `@sisal/libsql/migrate` when a narrower
 * boundary is better for an application.
 *
 * @module
 */

export {
  connect,
  createLibsqlClient,
  createLibsqlDb,
  createLibsqlExecutor,
  createLibsqlOrmDriver,
  isLibsqlUrl,
  LIBSQL_DIALECT,
  libsqlConfigFromOptions,
  openLibsqlClient,
} from "./orm/mod.ts";
export type {
  CreateLibsqlDbOptions,
  LibsqlArgs,
  LibsqlClient,
  LibsqlClientConfig,
  LibsqlConnectionOptions,
  LibsqlDatabase,
  LibsqlExecutorOptions,
  LibsqlIntMode,
  LibsqlInValue,
  LibsqlOrmDriverOptions,
  LibsqlQueryResult,
  LibsqlResultSet,
  LibsqlSqlExecutor,
  LibsqlStatement,
  LibsqlTransaction,
  LibsqlTransactionMode,
  LibsqlValue,
} from "./orm/mod.ts";

export {
  createLibsqlMigrationDriver,
  createLibsqlMigrationHistoryStore,
  createLibsqlMigrator,
  DEFAULT_LIBSQL_MIGRATION_TABLE,
} from "./migrate/mod.ts";
export type {
  CreateLibsqlMigratorOptions,
  LibsqlMigrateOptions,
  LibsqlMigrationDefinition,
  LibsqlMigrationDriverOptions,
  LibsqlMigrationHistoryStoreOptions,
  LibsqlMigrationInput,
  LibsqlMigrationPlanOptions,
  LibsqlMigrator,
  LibsqlRollbackOptions,
} from "./migrate/mod.ts";

export {
  generateLibsqlAddColumn,
  generateLibsqlColumnDefinition,
  generateLibsqlColumnType,
  generateLibsqlCreateTable,
  generateLibsqlUpStatements,
  quoteLibsqlIdent,
} from "./migrate/ddl.ts";
export type { LibsqlUpStatements } from "./migrate/ddl.ts";
