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

import { createPgMigrationDriver } from "./driver.ts";
import { createPgExecutor, type SqlExecutor } from "./executor.ts";
import { createPgMigrationHistoryStore } from "./history.ts";
import type { PgConnectionOptions } from "./pool.ts";

/** PostgreSQL convenience migration definition with inferred programmatic kind. */
export interface PgMigrationDefinition extends MigrationBase {
  /** Forward migration SQL or callback for this pg migration definition. */
  readonly kind?: never;
  /** Rollback SQL or callback for this pg migration definition. */
  readonly up: MigrationStep;
  /** Rollback SQL or callback for this pg migration definition. */
  readonly down?: MigrationStep;
}

/** Migration input accepted by the PostgreSQL migrator facade. */
export type PgMigrationInput = Migration | PgMigrationDefinition;

/** Options for applying pending PostgreSQL migrations. */
export interface PgMigrateOptions extends MigrationRunOptions {
  /** Migration input used by this pg migrate options. */
  readonly migrations: readonly PgMigrationInput[];
}

/** Options for rolling back PostgreSQL migrations. */
export interface PgRollbackOptions extends MigrationDownOptions {
  /** Migration input used by this pg rollback options. */
  readonly migrations: readonly PgMigrationInput[];
}

/** Options for planning PostgreSQL migrations without executing them. */
export interface PgMigrationPlanOptions {
  /** Migration input used by this pg migration plan options. */
  readonly migrations: readonly PgMigrationInput[];
}

/** PostgreSQL migration facade backed by the core migrator. */
export interface PgMigrator {
  /** Rolls back this pg migrator. */
  migrate(options: PgMigrateOptions): Promise<MigrationResult>;
  /** Builds a migration plan for this pg migrator. */
  rollback(options: PgRollbackOptions): Promise<MigrationResult>;
  /** Lists applied migrations for this pg migrator. */
  plan(options: PgMigrationPlanOptions): Promise<MigrationPlan>;
  /** Closes resources held by this pg migrator. */
  applied(): Promise<AppliedMigration[]>;
  /** Closes resources held by this pg migrator. */
  close(): Promise<void>;

  /** Async-disposal alias for {@link close} — enables `await using`. */
  [Symbol.asyncDispose](): Promise<void>;
}

/** Options for creating a PostgreSQL migration facade. */
export interface CreatePgMigratorOptions extends PgConnectionOptions {
  readonly executor?: SqlExecutor;
  readonly logger?: Logger;
  readonly logging?: SisalLoggingOptions;
  readonly historyTable?: string;
  readonly useTransaction?: boolean;
  /**
   * Apply each SQL migration statement-by-statement (see the core migrator's
   * `splitStatements`). Defaults to `false`; set it for single-statement
   * transports.
   */
  readonly splitStatements?: boolean;
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
  const driver = createPgMigrationDriver({
    executor,
    transactionStoreFactory: (txExecutor) =>
      createPgMigrationHistoryStore({
        executor: txExecutor,
        tableName: options.historyTable,
      }),
  });

  return Promise.resolve(
    new SisalPgMigrator({
      driver,
      store,
      logger: options.logger,
      logging: options.logging,
      useTransaction: options.useTransaction ?? true,
      splitStatements: options.splitStatements ?? false,
    }),
  );
}

class SisalPgMigrator implements PgMigrator {
  readonly #driver: ReturnType<typeof createPgMigrationDriver>;
  readonly #store: ReturnType<typeof createPgMigrationHistoryStore>;
  readonly #logger?: Logger;
  readonly #logging?: SisalLoggingOptions;
  readonly #useTransaction: boolean;
  readonly #splitStatements: boolean;

  constructor(options: {
    readonly driver: ReturnType<typeof createPgMigrationDriver>;
    readonly store: ReturnType<typeof createPgMigrationHistoryStore>;
    readonly logger?: Logger;
    readonly logging?: SisalLoggingOptions;
    readonly useTransaction: boolean;
    readonly splitStatements: boolean;
  }) {
    this.#driver = options.driver;
    this.#store = options.store;
    this.#logger = options.logger;
    this.#logging = options.logging;
    this.#useTransaction = options.useTransaction;
    this.#splitStatements = options.splitStatements;
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

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  #createCoreMigrator(migrations: readonly PgMigrationInput[]) {
    return createMigrator({
      migrations: normalizePgMigrations(migrations),
      store: this.#store,
      driver: this.#driver,
      logger: this.#logger,
      ...(this.#logging === undefined ? {} : { logging: this.#logging }),
      useTransaction: this.#useTransaction,
      splitStatements: this.#splitStatements,
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
