/**
 * PostgreSQL DDL helpers for Neon serverless workflows.
 *
 * Neon uses PostgreSQL syntax, so this module re-exports Sisal's Postgres DDL
 * helpers under the Neon package boundary.
 *
 * @module
 */

export {
  generatePostgresAddColumn,
  generatePostgresColumnDefinition,
  generatePostgresColumnType,
  generatePostgresCreateTable,
  generatePostgresUpStatements,
  pgQualifiedName,
  quotePgIdent,
} from "@sisal/pg/ddl";
export type { PostgresUpStatements } from "@sisal/pg/ddl";
