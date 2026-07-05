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
  DEFAULT_PG_DRIVER,
  POSTGRES_DIALECT,
  resolvePgDriverKind,
} from "./src/orm/mod.ts";
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
} from "./src/orm/mod.ts";

export {
  createPgMigrationDriver,
  createPgMigrationHistoryStore,
  createPgMigrator,
  DEFAULT_PG_MIGRATION_TABLE,
} from "./src/migrate/mod.ts";
export type {
  PgMigrateOptions,
  PgMigrationDefinition,
  PgMigrationDriverOptions,
  PgMigrationHistoryStoreOptions,
  PgMigrationInput,
  PgMigrationPlanOptions,
  PgMigrator,
  PgRollbackOptions,
} from "./src/migrate/mod.ts";

export {
  generatePostgresAddColumn,
  generatePostgresColumnDefinition,
  generatePostgresColumnType,
  generatePostgresCreateTable,
  generatePostgresUpStatements,
  pgQualifiedName,
  quotePgIdent,
} from "./src/migrate/ddl.ts";
export type { PostgresUpStatements } from "./src/migrate/ddl.ts";
