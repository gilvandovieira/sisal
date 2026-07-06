/**
 * Pure libSQL/Turso DDL generation.
 *
 * libSQL uses SQLite syntax, so these helpers delegate to the SQLite DDL
 * generator with libSQL-oriented names while keeping the public declarations
 * documented as `@sisal/libsql` API.
 *
 * @module
 */

import {
  generateSqliteAddColumn,
  generateSqliteColumnDefinition,
  generateSqliteColumnType,
  generateSqliteCreateTable,
  generateSqliteUpStatements,
  quoteSqliteIdent,
  type SqliteUpStatements,
} from "@sisal/sqlite/ddl";
import type {
  SisalColumnSnapshot,
  SisalColumnType,
  SisalSchemaSnapshot,
  SisalTableSnapshot,
} from "@sisal/orm";

/** Safe libSQL/SQLite up statements plus destructive changes withheld. */
export type LibsqlUpStatements = SqliteUpStatements;

/** Quotes a libSQL/SQLite identifier, escaping embedded double quotes. */
export function quoteLibsqlIdent(name: string): string {
  return quoteSqliteIdent(name);
}

/** Maps a Sisal snapshot column type to the SQLite affinity libSQL accepts. */
export function generateLibsqlColumnType(type: SisalColumnType): string {
  return generateSqliteColumnType(type);
}

/** Renders one libSQL/SQLite column definition. */
export function generateLibsqlColumnDefinition(
  column: SisalColumnSnapshot,
): string {
  return generateSqliteColumnDefinition(column);
}

/** Generates a libSQL/SQLite `CREATE TABLE` statement from one table snapshot. */
export function generateLibsqlCreateTable(table: SisalTableSnapshot): string {
  return generateSqliteCreateTable(table);
}

/** Generates a libSQL/SQLite `ALTER TABLE ... ADD COLUMN` statement. */
export function generateLibsqlAddColumn(
  table: { readonly name: string },
  column: SisalColumnSnapshot,
): string {
  return generateSqliteAddColumn(table, column);
}

/**
 * Generates non-destructive libSQL/SQLite migration statements from schema
 * snapshots, returning destructive changes separately.
 */
export function generateLibsqlUpStatements(
  to: SisalSchemaSnapshot,
  from?: SisalSchemaSnapshot,
): LibsqlUpStatements {
  return generateSqliteUpStatements(to, from);
}
