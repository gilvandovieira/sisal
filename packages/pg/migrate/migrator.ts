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

import { createPgMigrationDriver } from "./driver.ts";
import { createPgExecutor, type SqlExecutor } from "./executor.ts";
import { createPgMigrationHistoryStore } from "./history.ts";
import type { PgConnectionOptions } from "./pool.ts";

/** PostgreSQL convenience migration definition with inferred programmatic kind. */
export interface PgMigrationDefinition extends MigrationBase {
  readonly kind?: never;
  readonly up: MigrationStep;
  readonly down?: MigrationStep;
}

/** Migration input accepted by the PostgreSQL migrator facade. */
export type PgMigrationInput = Migration | PgMigrationDefinition;

/** Options for applying pending PostgreSQL migrations. */
export interface PgMigrateOptions extends MigrationRunOptions {
  readonly migrations: readonly PgMigrationInput[];
}

/** Options for rolling back PostgreSQL migrations. */
export interface PgRollbackOptions extends MigrationDownOptions {
  readonly migrations: readonly PgMigrationInput[];
}

/** Options for planning PostgreSQL migrations without executing them. */
export interface PgMigrationPlanOptions {
  readonly migrations: readonly PgMigrationInput[];
}

/** PostgreSQL migration facade backed by the core migrator. */
export interface PgMigrator {
  migrate(options: PgMigrateOptions): Promise<MigrationResult>;
  rollback(options: PgRollbackOptions): Promise<MigrationResult>;
  plan(options: PgMigrationPlanOptions): Promise<MigrationPlan>;
  applied(): Promise<AppliedMigration[]>;
  close(): Promise<void>;
}

/** Options for creating a PostgreSQL migration facade. */
export interface CreatePgMigratorOptions extends PgConnectionOptions {
  readonly executor?: SqlExecutor;
  readonly logger?: Logger;
  readonly historyTable?: string;
  readonly useTransaction?: boolean;
}

/** Creates a PostgreSQL migration facade with a database-backed history store. */
export function createPgMigrator(
  options: CreatePgMigratorOptions,
): Promise<PgMigrator> {
  const executor = createPgExecutor(options);
  const store = createPgMigrationHistoryStore({
    executor,
    tableName: options.historyTable,
  });
  const driver = createPgMigrationDriver({ executor });

  return Promise.resolve(
    new SisalPgMigrator({
      driver,
      store,
      logger: options.logger,
      useTransaction: options.useTransaction ?? true,
    }),
  );
}

class SisalPgMigrator implements PgMigrator {
  readonly #driver: ReturnType<typeof createPgMigrationDriver>;
  readonly #store: ReturnType<typeof createPgMigrationHistoryStore>;
  readonly #logger?: Logger;
  readonly #useTransaction: boolean;

  constructor(options: {
    readonly driver: ReturnType<typeof createPgMigrationDriver>;
    readonly store: ReturnType<typeof createPgMigrationHistoryStore>;
    readonly logger?: Logger;
    readonly useTransaction: boolean;
  }) {
    this.#driver = options.driver;
    this.#store = options.store;
    this.#logger = options.logger;
    this.#useTransaction = options.useTransaction;
  }

  migrate(options: PgMigrateOptions): Promise<MigrationResult> {
    return this.#createCoreMigrator(options.migrations).up(options);
  }

  rollback(options: PgRollbackOptions): Promise<MigrationResult> {
    return this.#createCoreMigrator(options.migrations).down(options);
  }

  plan(options: PgMigrationPlanOptions): Promise<MigrationPlan> {
    return this.#createCoreMigrator(options.migrations).plan();
  }

  applied(): Promise<AppliedMigration[]> {
    return this.#store.listApplied();
  }

  async close(): Promise<void> {
    await this.#store.close?.();
    await this.#driver.close?.();
  }

  #createCoreMigrator(migrations: readonly PgMigrationInput[]) {
    return createMigrator({
      migrations: normalizePgMigrations(migrations),
      store: this.#store,
      driver: this.#driver,
      logger: this.#logger,
      useTransaction: this.#useTransaction,
    });
  }
}

function normalizePgMigrations(
  migrations: readonly PgMigrationInput[],
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

function isCoreMigration(migration: PgMigrationInput): migration is Migration {
  return migration.kind === "sql" || migration.kind === "programmatic";
}
