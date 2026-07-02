/**
 * MySQL/MariaDB adapter package for Sisal.
 *
 * The root export provides the MySQL ORM helpers, the migration boundary
 * (driver, `GET_LOCK`-backed history store, migrator facade), and the pure
 * DDL generator. Import `@sisal/mysql/orm`, `@sisal/mysql/migrate`, or
 * `@sisal/mysql/ddl` when a narrower boundary is better for an application.
 *
 * @module
 */

export {
  adaptMariadbPool,
  connect,
  createMariadbPool,
  createMysqlDb,
  createMysqlExecutor,
  createMysqlOrmDriver,
  createMysqlPool,
  insertReturning,
  MARIADB_VARIANT,
  MYSQL_DIALECT,
  parseMysqlServerVersion,
} from "./orm/mod.ts";
export {
  createMysqlMigrateExecutor,
  createMysqlMigrationDriver,
  createMysqlMigrationHistoryStore,
  createMysqlMigrator,
  DEFAULT_MYSQL_MIGRATION_TABLE,
} from "./migrate/mod.ts";
export type {
  CreateMysqlMigratorOptions,
  MysqlMigrateOptions,
  MysqlMigrationDefinition,
  MysqlMigrationDriverOptions,
  MysqlMigrationHistoryStoreOptions,
  MysqlMigrationInput,
  MysqlMigrationPlanOptions,
  MysqlMigrator,
  MysqlRollbackOptions,
  QueryResult,
  SqlExecutor,
  SqlExecutorSession,
} from "./migrate/mod.ts";
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
} from "./migrate/ddl.ts";
export type { MysqlUpStatements } from "./migrate/ddl.ts";
export type {
  CreateMysqlDbOptions,
  MysqlClient,
  MysqlConnectionOptions,
  MysqlDatabase,
  MysqlDriverKind,
  MysqlDriverRows,
  MysqlOrmDriverOptions,
  MysqlPool,
  MysqlQueryResult,
  MysqlResultHeader,
  MysqlServerIdentity,
  MysqlSqlExecutor,
} from "./orm/mod.ts";
