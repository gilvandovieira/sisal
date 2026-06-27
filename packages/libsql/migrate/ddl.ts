/**
 * Pure libSQL/Turso DDL generation.
 *
 * libSQL uses SQLite syntax, so these helpers are aliases around the SQLite DDL
 * generator with libSQL-oriented names.
 *
 * @module
 */

export {
  generateSqliteAddColumn as generateLibsqlAddColumn,
  generateSqliteColumnDefinition as generateLibsqlColumnDefinition,
  generateSqliteColumnType as generateLibsqlColumnType,
  generateSqliteCreateTable as generateLibsqlCreateTable,
  generateSqliteUpStatements as generateLibsqlUpStatements,
  quoteSqliteIdent as quoteLibsqlIdent,
} from "@sisal/sqlite/ddl";
export type { SqliteUpStatements as LibsqlUpStatements } from "@sisal/sqlite/ddl";
