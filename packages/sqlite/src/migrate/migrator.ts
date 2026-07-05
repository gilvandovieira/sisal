import type { Logger, SisalLoggingOptions } from "@sisal/orm";

import {
  type AppliedMigration,
  createMigrator,
  defineMigration,
  defineSqlMigration,
  type Migration,
  type MigrationBase,
  type MigrationDownOptions,
  type MigrationPlan,
  type MigrationResult,
  type MigrationRunOptions,
  type MigrationStep,
} from "@sisal/migrate";

import type { SqliteConnectionOptions } from "./database.ts";
import { openSqliteDatabase, type SqliteLikeDatabase } from "./database.ts";
import { createSqliteMigrationDriver } from "./driver.ts";
import { createSqliteExecutor, type SqlExecutor } from "./executor.ts";
import { createSqliteMigrationHistoryStore } from "./history.ts";

/** SQLite convenience migration definition with inferred programmatic kind. */
export interface SqliteMigrationDefinition extends MigrationBase {
  /** Forward migration SQL or callback for this sqlite migration definition. */
  readonly kind?: never;
  /** Rollback SQL or callback for this sqlite migration definition. */
  readonly up: MigrationStep;
  /** Rollback SQL or callback for this sqlite migration definition. */
  readonly down?: MigrationStep;
}

/** Migration input accepted by the SQLite migrator facade. */
export type SqliteMigrationInput = Migration | SqliteMigrationDefinition;

/** Options for applying pending SQLite migrations. */
export interface SqliteMigrateOptions extends MigrationRunOptions {
  /** Migration input used by this sqlite migrate options. */
  readonly migrations: readonly SqliteMigrationInput[];
}

/** Options for rolling back SQLite migrations. */
export interface SqliteRollbackOptions extends MigrationDownOptions {
  /** Migration input used by this sqlite rollback options. */
  readonly migrations: readonly SqliteMigrationInput[];
}

/** Options for planning SQLite migrations without executing them. */
export interface SqliteMigrationPlanOptions {
  /** Migration input used by this sqlite migration plan options. */
  readonly migrations: readonly SqliteMigrationInput[];
}

/** SQLite migration facade backed by the core migrator. */
export interface SqliteMigrator {
  /** Rolls back this sqlite migrator. */
  migrate(options: SqliteMigrateOptions): Promise<MigrationResult>;
  /** Builds a migration plan for this sqlite migrator. */
  rollback(options: SqliteRollbackOptions): Promise<MigrationResult>;
  /** Lists applied migrations for this sqlite migrator. */
  plan(options: SqliteMigrationPlanOptions): Promise<MigrationPlan>;
  /** Closes resources held by this sqlite migrator. */
  applied(): Promise<AppliedMigration[]>;
  /** Closes resources held by this sqlite migrator. */
  close(): Promise<void>;

  /** Async-disposal alias for {@link close} — enables `await using`. */
  [Symbol.asyncDispose](): Promise<void>;
}

/** Options for creating a SQLite migration facade. */
export interface CreateSqliteMigratorOptions extends SqliteConnectionOptions {
  /** Logger used by this create sqlite migrator options. */
  readonly executor?: SqlExecutor;
  /** Logging options used by this create sqlite migrator options. */
  readonly logger?: Logger;
  /** History table name used by this create sqlite migrator options. */
  readonly logging?: SisalLoggingOptions;
  /** Transaction behavior for this create sqlite migrator options. */
  readonly historyTable?: string;
  /** Transaction behavior for this create sqlite migrator options. */
  readonly useTransaction?: boolean;
}

/** Creates a SQLite migration facade with a database-backed history store. */
export async function createSqliteMigrator(
  options: CreateSqliteMigratorOptions = {},
): Promise<SqliteMigrator> {
  let database: SqliteLikeDatabase | undefined = options.database;
  let ownsDatabase = false;

  // Only open a real `@db/sqlite` handle (FFI) when neither an executor nor an
  // open database was injected.
  if (options.executor === undefined && database === undefined) {
    database = await openSqliteDatabase(options);
    ownsDatabase = true;
  }

  const executor = createSqliteExecutor({
    executor: options.executor,
    database,
    ownsDatabase,
  });
  const store = createSqliteMigrationHistoryStore({
    executor,
    tableName: options.historyTable,
  });
  const driver = createSqliteMigrationDriver({ executor });

  return new SisalSqliteMigrator({
    driver,
    store,
    logger: options.logger,
    logging: options.logging,
    useTransaction: options.useTransaction ?? true,
  });
}

class SisalSqliteMigrator implements SqliteMigrator {
  readonly #driver: ReturnType<typeof createSqliteMigrationDriver>;
  readonly #store: ReturnType<typeof createSqliteMigrationHistoryStore>;
  readonly #logger?: Logger;
  readonly #logging?: SisalLoggingOptions;
  readonly #useTransaction: boolean;

  constructor(options: {
    readonly driver: ReturnType<typeof createSqliteMigrationDriver>;
    readonly store: ReturnType<typeof createSqliteMigrationHistoryStore>;
    readonly logger?: Logger;
    readonly logging?: SisalLoggingOptions;
    readonly useTransaction: boolean;
  }) {
    this.#driver = options.driver;
    this.#store = options.store;
    this.#logger = options.logger;
    this.#logging = options.logging;
    this.#useTransaction = options.useTransaction;
  }

  migrate(options: SqliteMigrateOptions): Promise<MigrationResult> {
    return this.#createCoreMigrator(options.migrations).up(options);
  }

  rollback(options: SqliteRollbackOptions): Promise<MigrationResult> {
    return this.#createCoreMigrator(options.migrations).down(options);
  }

  plan(options: SqliteMigrationPlanOptions): Promise<MigrationPlan> {
    return this.#createCoreMigrator(options.migrations).plan();
  }

  applied(): Promise<AppliedMigration[]> {
    return this.#store.listApplied();
  }

  async close(): Promise<void> {
    await this.#store.close?.();
    await this.#driver.close?.();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  #createCoreMigrator(migrations: readonly SqliteMigrationInput[]) {
    return createMigrator({
      migrations: normalizeSqliteMigrations(migrations),
      store: this.#store,
      driver: this.#driver,
      logger: this.#logger,
      ...(this.#logging === undefined ? {} : { logging: this.#logging }),
      useTransaction: this.#useTransaction,
    });
  }
}

function normalizeSqliteMigrations(
  migrations: readonly SqliteMigrationInput[],
): Migration[] {
  return migrations.map((migration) => {
    if (isCoreMigration(migration)) {
      return migration;
    }

    if (
      typeof migration.up === "string" &&
      (migration.down === undefined || typeof migration.down === "string")
    ) {
      return defineSqlMigration({
        id: migration.id,
        description: migration.description,
        checksum: migration.checksum,
        createdAt: migration.createdAt,
        up: migration.up,
        down: migration.down,
      });
    }

    return defineMigration({
      id: migration.id,
      description: migration.description,
      checksum: migration.checksum,
      createdAt: migration.createdAt,
      up: migration.up,
      down: migration.down,
    });
  });
}

function isCoreMigration(
  migration: SqliteMigrationInput,
): migration is Migration {
  return migration.kind === "sql" || migration.kind === "programmatic";
}
