import type { Logger } from "@sisal/orm";

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
  readonly kind?: never;
  readonly up: MigrationStep;
  readonly down?: MigrationStep;
}

/** Migration input accepted by the SQLite migrator facade. */
export type SqliteMigrationInput = Migration | SqliteMigrationDefinition;

/** Options for applying pending SQLite migrations. */
export interface SqliteMigrateOptions extends MigrationRunOptions {
  readonly migrations: readonly SqliteMigrationInput[];
}

/** Options for rolling back SQLite migrations. */
export interface SqliteRollbackOptions extends MigrationDownOptions {
  readonly migrations: readonly SqliteMigrationInput[];
}

/** Options for planning SQLite migrations without executing them. */
export interface SqliteMigrationPlanOptions {
  readonly migrations: readonly SqliteMigrationInput[];
}

/** SQLite migration facade backed by the core migrator. */
export interface SqliteMigrator {
  migrate(options: SqliteMigrateOptions): Promise<MigrationResult>;
  rollback(options: SqliteRollbackOptions): Promise<MigrationResult>;
  plan(options: SqliteMigrationPlanOptions): Promise<MigrationPlan>;
  applied(): Promise<AppliedMigration[]>;
  close(): Promise<void>;
}

/** Options for creating a SQLite migration facade. */
export interface CreateSqliteMigratorOptions extends SqliteConnectionOptions {
  readonly executor?: SqlExecutor;
  readonly logger?: Logger;
  readonly historyTable?: string;
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
    useTransaction: options.useTransaction ?? true,
  });
}

class SisalSqliteMigrator implements SqliteMigrator {
  readonly #driver: ReturnType<typeof createSqliteMigrationDriver>;
  readonly #store: ReturnType<typeof createSqliteMigrationHistoryStore>;
  readonly #logger?: Logger;
  readonly #useTransaction: boolean;

  constructor(options: {
    readonly driver: ReturnType<typeof createSqliteMigrationDriver>;
    readonly store: ReturnType<typeof createSqliteMigrationHistoryStore>;
    readonly logger?: Logger;
    readonly useTransaction: boolean;
  }) {
    this.#driver = options.driver;
    this.#store = options.store;
    this.#logger = options.logger;
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

  #createCoreMigrator(migrations: readonly SqliteMigrationInput[]) {
    return createMigrator({
      migrations: normalizeSqliteMigrations(migrations),
      store: this.#store,
      driver: this.#driver,
      logger: this.#logger,
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
