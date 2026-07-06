/**
 * PostgreSQL DDL helpers for Neon serverless workflows.
 *
 * Neon uses PostgreSQL syntax, so this module exposes Sisal's PostgreSQL DDL
 * behavior through the Neon package boundary while keeping the declarations
 * documented as `@sisal/neon` API.
 *
 * @module
 */

import {
  generatePostgresAddColumn as generatePgAddColumn,
  generatePostgresColumnDefinition as generatePgColumnDefinition,
  generatePostgresColumnType as generatePgColumnType,
  generatePostgresCreateTable as generatePgCreateTable,
  generatePostgresUpStatements as generatePgUpStatements,
  pgQualifiedName as pgQualifiedTableName,
  type PostgresUpStatements as PgPostgresUpStatements,
  quotePgIdent as quotePostgresIdentifier,
} from "@sisal/pg/ddl";
import type {
  SisalColumnSnapshot,
  SisalColumnType,
  SisalSchemaSnapshot,
  SisalTableSnapshot,
} from "@sisal/orm";

/** Safe Neon/PostgreSQL up statements plus destructive changes withheld. */
export type PostgresUpStatements = PgPostgresUpStatements;

/** Quotes a PostgreSQL identifier for Neon DDL. */
export function quotePgIdent(name: string): string {
  return quotePostgresIdentifier(name);
}

/** Renders a qualified PostgreSQL table name for Neon DDL. */
export function pgQualifiedName(table: {
  readonly name: string;
  readonly schema?: string;
}): string {
  return pgQualifiedTableName(table);
}

/** Maps a Sisal snapshot column type to the PostgreSQL type Neon accepts. */
export function generatePostgresColumnType(type: SisalColumnType): string {
  return generatePgColumnType(type);
}

/** Renders one Neon/PostgreSQL column definition. */
export function generatePostgresColumnDefinition(
  column: SisalColumnSnapshot,
): string {
  return generatePgColumnDefinition(column);
}

/** Generates a Neon/PostgreSQL `CREATE TABLE` statement from one table snapshot. */
export function generatePostgresCreateTable(
  table: SisalTableSnapshot,
): string {
  return generatePgCreateTable(table);
}

/** Generates a Neon/PostgreSQL `ALTER TABLE ... ADD COLUMN` statement. */
export function generatePostgresAddColumn(
  table: { readonly name: string; readonly schema?: string },
  column: SisalColumnSnapshot,
): string {
  return generatePgAddColumn(table, column);
}

/**
 * Generates non-destructive Neon/PostgreSQL migration statements from schema
 * snapshots, returning destructive changes separately.
 */
export function generatePostgresUpStatements(
  to: SisalSchemaSnapshot,
  from?: SisalSchemaSnapshot,
): PostgresUpStatements {
  return generatePgUpStatements(to, from);
}
