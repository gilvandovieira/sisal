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
  /** Forward migration SQL or callback for this libsql migration definition. */
  readonly kind?: never;
  /** Rollback SQL or callback for this libsql migration definition. */
  readonly up: MigrationStep;
  /** Rollback SQL or callback for this libsql migration definition. */
  readonly down?: MigrationStep;
}

/** Migration input accepted by the libSQL migrator facade. */
export type LibsqlMigrationInput = Migration | LibsqlMigrationDefinition;

/** Options for applying pending libSQL migrations. */
export interface LibsqlMigrateOptions extends MigrationRunOptions {
  /** Migration input used by this libsql migrate options. */
  readonly migrations: readonly LibsqlMigrationInput[];
}

/** Options for rolling back libSQL migrations. */
export interface LibsqlRollbackOptions extends MigrationDownOptions {
  /** Migration input used by this libsql rollback options. */
  readonly migrations: readonly LibsqlMigrationInput[];
}

/** Options for planning libSQL migrations without executing them. */
export interface LibsqlMigrationPlanOptions {
  /** Migration input used by this libsql migration plan options. */
  readonly migrations: readonly LibsqlMigrationInput[];
}

/** libSQL migration facade backed by the core migrator. */
export interface LibsqlMigrator {
  /** Rolls back this libsql migrator. */
  migrate(options: LibsqlMigrateOptions): Promise<MigrationResult>;
  /** Builds a migration plan for this libsql migrator. */
  rollback(options: LibsqlRollbackOptions): Promise<MigrationResult>;
  /** Lists applied migrations for this libsql migrator. */
  plan(options: LibsqlMigrationPlanOptions): Promise<MigrationPlan>;
  /** Closes resources held by this libsql migrator. */
  applied(): Promise<AppliedMigration[]>;
  /** Closes resources held by this libsql migrator. */
  close(): Promise<void>;

  /** Async-disposal alias for {@link close} — enables `await using`. */
  [Symbol.asyncDispose](): Promise<void>;
}

/** Options for creating a libSQL migration facade. */
export interface CreateLibsqlMigratorOptions extends LibsqlConnectionOptions {
  /** Logger used by this create libsql migrator options. */
  readonly executor?: SqlExecutor;
  /** Logging options used by this create libsql migrator options. */
  readonly logger?: Logger;
  /** History table name used by this create libsql migrator options. */
  readonly logging?: SisalLoggingOptions;
  /** Transaction behavior for this create libsql migrator options. */
  readonly historyTable?: string;
  /** Transaction behavior for this create libsql migrator options. */
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

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
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
