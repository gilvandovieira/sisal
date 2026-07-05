/**
 * MySQL/MariaDB adapter for `@sisal/migrate`.
 *
 * Provides MySQL migration drivers, a table-backed history store with
 * `GET_LOCK`/`RELEASE_LOCK` named-lock exclusion (the `pg_advisory_lock`
 * analogue), the migrator facade, and additive DDL generation helpers.
 *
 * @module
 */

export type {
  CreateMysqlMigratorOptions,
  MysqlMigrateOptions,
  MysqlMigrationDefinition,
  MysqlMigrationInput,
  MysqlMigrationPlanOptions,
  MysqlMigrator,
  MysqlRollbackOptions,
} from "./migrator.ts";
export { createMysqlMigrator } from "./migrator.ts";

export type {
  QueryResult,
  SqlExecutor,
  SqlExecutorSession,
} from "./executor.ts";
export { createMysqlMigrateExecutor } from "./executor.ts";

export { createMysqlMigrationDriver } from "./driver.ts";
export type { MysqlMigrationDriverOptions } from "./driver.ts";

export {
  createMysqlMigrationHistoryStore,
  DEFAULT_MYSQL_MIGRATION_TABLE,
} from "./history.ts";
export type { MysqlMigrationHistoryStoreOptions } from "./history.ts";

export type { MysqlUpStatements } from "./ddl.ts";
export {
  generateMysqlAddColumn,
  generateMysqlColumnDefinition,
  generateMysqlColumnType,
  generateMysqlCreateTable,
  generateMysqlForeignKeys,
  generateMysqlIndexes,
  generateMysqlUpStatements,
  mysqlQualifiedName,
  quoteMysqlIdent,
} from "./ddl.ts";
