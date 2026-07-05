/**
 * SQLite adapter package for Sisal.
 *
 * The root export provides the most common SQLite ORM and migration helpers.
 * Import `@sisal/sqlite/orm` or `@sisal/sqlite/migrate` when a narrower
 * boundary is better for an application.
 *
 * @module
 */

export {
  connect,
  createSqliteDb,
  createSqliteExecutor,
  createSqliteOrmDriver,
  openSqliteDatabase,
  SQLITE_DIALECT,
  sqliteColumnAffinity,
  statementReturnsRows,
} from "./src/orm/mod.ts";
export type {
  CreateSqliteDbOptions,
  SqliteConnectionOptions,
  SqliteDatabase,
  SqliteExecutorOptions,
  SqliteLikeDatabase,
  SqliteOrmDriverOptions,
  SqliteQueryResult,
  SqliteSqlExecutor,
  SqliteStatement,
} from "./src/orm/mod.ts";

export {
  createSqliteMigrationDriver,
  createSqliteMigrationHistoryStore,
  createSqliteMigrator,
  DEFAULT_SQLITE_MIGRATION_TABLE,
} from "./src/migrate/mod.ts";
export type {
  CreateSqliteMigratorOptions,
  SqliteMigrateOptions,
  SqliteMigrationDefinition,
  SqliteMigrationDriverOptions,
  SqliteMigrationHistoryStoreOptions,
  SqliteMigrationInput,
  SqliteMigrationPlanOptions,
  SqliteMigrator,
  SqliteRollbackOptions,
} from "./src/migrate/mod.ts";

export {
  generateSqliteAddColumn,
  generateSqliteColumnDefinition,
  generateSqliteColumnType,
  generateSqliteCreateTable,
  generateSqliteUpStatements,
  quoteSqliteIdent,
} from "./src/migrate/ddl.ts";
export type { SqliteUpStatements } from "./src/migrate/ddl.ts";
