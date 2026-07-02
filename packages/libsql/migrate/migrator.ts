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

import type { LibsqlClient, LibsqlConnectionOptions } from "../client.ts";
import { createLibsqlMigrationDriver } from "./driver.ts";
import {
  createLibsqlExecutor,
  openLibsqlClient,
  type SqlExecutor,
} from "./executor.ts";
import { createLibsqlMigrationHistoryStore } from "./history.ts";

/** libSQL convenience migration definition with inferred programmatic kind. */
export interface LibsqlMigrationDefinition extends MigrationBase {
  readonly kind?: never;
  readonly up: MigrationStep;
  readonly down?: MigrationStep;
}

/** Migration input accepted by the libSQL migrator facade. */
export type LibsqlMigrationInput = Migration | LibsqlMigrationDefinition;

/** Options for applying pending libSQL migrations. */
export interface LibsqlMigrateOptions extends MigrationRunOptions {
  readonly migrations: readonly LibsqlMigrationInput[];
}

/** Options for rolling back libSQL migrations. */
export interface LibsqlRollbackOptions extends MigrationDownOptions {
  readonly migrations: readonly LibsqlMigrationInput[];
}

/** Options for planning libSQL migrations without executing them. */
export interface LibsqlMigrationPlanOptions {
  readonly migrations: readonly LibsqlMigrationInput[];
}

/** libSQL migration facade backed by the core migrator. */
export interface LibsqlMigrator {
  migrate(options: LibsqlMigrateOptions): Promise<MigrationResult>;
  rollback(options: LibsqlRollbackOptions): Promise<MigrationResult>;
  plan(options: LibsqlMigrationPlanOptions): Promise<MigrationPlan>;
  applied(): Promise<AppliedMigration[]>;
  close(): Promise<void>;
}

/** Options for creating a libSQL migration facade. */
export interface CreateLibsqlMigratorOptions extends LibsqlConnectionOptions {
  readonly executor?: SqlExecutor;
  readonly logger?: Logger;
  readonly logging?: SisalLoggingOptions;
  readonly historyTable?: string;
  readonly useTransaction?: boolean;
}

/** Creates a libSQL migration facade with a database-backed history store. */
export async function createLibsqlMigrator(
  options: CreateLibsqlMigratorOptions,
): Promise<LibsqlMigrator> {
  let client: LibsqlClient | undefined = options.client;
  let ownsClient = false;

  if (options.executor === undefined && client === undefined) {
    client = await openLibsqlClient(options);
    ownsClient = true;
  }

  const executor = createLibsqlExecutor({
    executor: options.executor,
    client,
    ownsClient,
  });
  const store = createLibsqlMigrationHistoryStore({
    executor,
    tableName: options.historyTable,
  });
  const driver = createLibsqlMigrationDriver({
    executor,
    transactionStoreFactory: (txExecutor) =>
      createLibsqlMigrationHistoryStore({
        executor: txExecutor,
        tableName: options.historyTable,
      }),
  });

  return new SisalLibsqlMigrator({
    driver,
    store,
    logger: options.logger,
    logging: options.logging,
    useTransaction: options.useTransaction ?? true,
  });
}

class SisalLibsqlMigrator implements LibsqlMigrator {
  readonly #driver: ReturnType<typeof createLibsqlMigrationDriver>;
  readonly #store: ReturnType<typeof createLibsqlMigrationHistoryStore>;
  readonly #logger?: Logger;
  readonly #logging?: SisalLoggingOptions;
  readonly #useTransaction: boolean;

  constructor(options: {
    readonly driver: ReturnType<typeof createLibsqlMigrationDriver>;
    readonly store: ReturnType<typeof createLibsqlMigrationHistoryStore>;
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

  migrate(options: LibsqlMigrateOptions): Promise<MigrationResult> {
    return this.#createCoreMigrator(options.migrations).up(options);
  }

  rollback(options: LibsqlRollbackOptions): Promise<MigrationResult> {
    return this.#createCoreMigrator(options.migrations).down(options);
  }

  plan(options: LibsqlMigrationPlanOptions): Promise<MigrationPlan> {
    return this.#createCoreMigrator(options.migrations).plan();
  }

  applied(): Promise<AppliedMigration[]> {
    return this.#store.listApplied();
  }

  async close(): Promise<void> {
    await this.#store.close?.();
    await this.#driver.close?.();
  }

  #createCoreMigrator(migrations: readonly LibsqlMigrationInput[]) {
    return createMigrator({
      migrations: normalizeLibsqlMigrations(migrations),
      store: this.#store,
      driver: this.#driver,
      logger: this.#logger,
      ...(this.#logging === undefined ? {} : { logging: this.#logging }),
      useTransaction: this.#useTransaction,
    });
  }
}

function normalizeLibsqlMigrations(
  migrations: readonly LibsqlMigrationInput[],
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
  migration: LibsqlMigrationInput,
): migration is Migration {
  return migration.kind === "sql" || migration.kind === "programmatic";
}
