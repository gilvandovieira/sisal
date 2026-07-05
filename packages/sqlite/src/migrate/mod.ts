/**
 * SQLite adapter for `@sisal/migrate`.
 *
 * Provides SQLite migration drivers, history stores, migrators, DDL generation,
 * and lazy `@db/sqlite` database opening for local migration workflows.
 *
 * @module
 */

export { SQLITE_DIALECT } from "./dialect.ts";

export type {
  SqliteConnectionOptions,
  SqliteLikeDatabase,
  SqliteStatement,
} from "./database.ts";
export { openSqliteDatabase, statementReturnsRows } from "./database.ts";

export type {
  CreateSqliteMigratorOptions,
  SqliteMigrateOptions,
  SqliteMigrationDefinition,
  SqliteMigrationInput,
  SqliteMigrationPlanOptions,
  SqliteMigrator,
  SqliteRollbackOptions,
} from "./migrator.ts";
export { createSqliteMigrator } from "./migrator.ts";

export type {
  QueryResult,
  SqlExecutor,
  SqliteExecutorOptions,
} from "./executor.ts";
export { createSqliteExecutor } from "./executor.ts";

export { createSqliteMigrationDriver } from "./driver.ts";
export type { SqliteMigrationDriverOptions } from "./driver.ts";

export {
  createSqliteMigrationHistoryStore,
  DEFAULT_SQLITE_MIGRATION_TABLE,
} from "./history.ts";
export type { SqliteMigrationHistoryStoreOptions } from "./history.ts";

export type { SqliteUpStatements } from "./ddl.ts";
export {
  generateSqliteAddColumn,
  generateSqliteColumnDefinition,
  generateSqliteColumnType,
  generateSqliteCreateTable,
  generateSqliteUpStatements,
  quoteSqliteIdent,
} from "./ddl.ts";
