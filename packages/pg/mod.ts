/**
 * PostgreSQL adapter package for Sisal.
 *
 * The root export provides the most common PostgreSQL ORM and migration helpers.
 * Import `@sisal/pg/orm` or `@sisal/pg/migrate` when a narrower boundary is
 * better for an application.
 *
 * @module
 */

export {
  connect,
  createPgDb,
  createPgExecutor,
  createPgOrmDriver,
  createPgPool,
  createPostgresJsPool,
  POSTGRES_DIALECT,
} from "./orm/mod.ts";
export type {
  CreatePgDbOptions,
  PgClient,
  PgConnectionOptions,
  PgDatabase,
  PgDriverKind,
  PgOrmDriverOptions,
  PgPool,
  PgQueryResult,
  PgSqlExecutor,
  PostgresJsPoolOptions,
} from "./orm/mod.ts";

export {
  createPgMigrationDriver,
  createPgMigrationHistoryStore,
  createPgMigrator,
  DEFAULT_PG_MIGRATION_TABLE,
} from "./migrate/mod.ts";
export type {
  PgMigrateOptions,
  PgMigrationDefinition,
  PgMigrationDriverOptions,
  PgMigrationHistoryStoreOptions,
  PgMigrationInput,
  PgMigrationPlanOptions,
  PgMigrator,
  PgRollbackOptions,
} from "./migrate/mod.ts";

export {
  generatePostgresAddColumn,
  generatePostgresColumnDefinition,
  generatePostgresColumnType,
  generatePostgresCreateTable,
  generatePostgresUpStatements,
  pgQualifiedName,
  quotePgIdent,
} from "./migrate/ddl.ts";
export type { PostgresUpStatements } from "./migrate/ddl.ts";
