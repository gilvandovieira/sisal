/**
 * MySQL/MariaDB migration facade over the core `@sisal/migrate` migrator.
 *
 * @module
 */

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

import type { MysqlConnectionOptions } from "../orm/pool.ts";
import { createMysqlMigrationDriver } from "./driver.ts";
import { createMysqlMigrateExecutor, type SqlExecutor } from "./executor.ts";
import { createMysqlMigrationHistoryStore } from "./history.ts";

/** MySQL convenience migration definition with inferred programmatic kind. */
export interface MysqlMigrationDefinition extends MigrationBase {
  /** Forward migration SQL or callback for this mysql migration definition. */
  readonly kind?: never;
  /** Rollback SQL or callback for this mysql migration definition. */
  readonly up: MigrationStep;
  /** Rollback SQL or callback for this mysql migration definition. */
  readonly down?: MigrationStep;
}

/** Migration input accepted by the MySQL migrator facade. */
export type MysqlMigrationInput = Migration | MysqlMigrationDefinition;

/** Options for applying pending MySQL migrations. */
export interface MysqlMigrateOptions extends MigrationRunOptions {
  /** Migration input used by this mysql migrate options. */
  readonly migrations: readonly MysqlMigrationInput[];
}

/** Options for rolling back MySQL migrations. */
export interface MysqlRollbackOptions extends MigrationDownOptions {
  /** Migration input used by this mysql rollback options. */
  readonly migrations: readonly MysqlMigrationInput[];
}

/** Options for planning MySQL migrations without executing them. */
export interface MysqlMigrationPlanOptions {
  /** Migration input used by this mysql migration plan options. */
  readonly migrations: readonly MysqlMigrationInput[];
}

/** MySQL migration facade backed by the core migrator. */
export interface MysqlMigrator {
  /** Rolls back this mysql migrator. */
  migrate(options: MysqlMigrateOptions): Promise<MigrationResult>;
  /** Builds a migration plan for this mysql migrator. */
  rollback(options: MysqlRollbackOptions): Promise<MigrationResult>;
  /** Lists applied migrations for this mysql migrator. */
  plan(options: MysqlMigrationPlanOptions): Promise<MigrationPlan>;
  /** Closes resources held by this mysql migrator. */
  applied(): Promise<AppliedMigration[]>;
  /** Closes resources held by this mysql migrator. */
  close(): Promise<void>;

  /** Async-disposal alias for {@link close} — enables `await using`. */
  [Symbol.asyncDispose](): Promise<void>;
}

/** Options for creating a MySQL migration facade. */
export interface CreateMysqlMigratorOptions extends MysqlConnectionOptions {
  /** Logger used by this create mysql migrator options. */
  readonly executor?: SqlExecutor;
  /** Logging options used by this create mysql migrator options. */
  readonly logger?: Logger;
  /** History table name used by this create mysql migrator options. */
  readonly logging?: SisalLoggingOptions;
  /** History table name used by this create mysql migrator options. */
  readonly historyTable?: string;
  /**
   * Wrap each migration in a transaction. Defaults to **`false`** — unlike
   * pg, MySQL/MariaDB have no transactional DDL: every `CREATE`/`ALTER`
   * statement **implicitly commits** the open transaction, so a wrap around
   * schema migrations is a false promise (a mid-migration failure cannot
   * roll the DDL back). Opt in for DML-only migrations, where the wrap is
   * real and also makes the history mark atomic with the change.
   */
  readonly useTransaction?: boolean;
  /**
   * Apply each SQL migration statement-by-statement (see the core migrator's
   * `splitStatements`). Defaults to `false`; set it for single-statement
   * transports.
   */
  readonly splitStatements?: boolean;
}

/** Creates a MySQL migration facade with a database-backed history store. */
export function createMysqlMigrator(
  options: CreateMysqlMigratorOptions,
): Promise<MysqlMigrator> {
  const executor = createMysqlMigrateExecutor(options);
  const store = createMysqlMigrationHistoryStore({
    executor,
    tableName: options.historyTable,
  });
  const driver = createMysqlMigrationDriver({
    executor,
    transactionStoreFactory: (txExecutor) =>
      createMysqlMigrationHistoryStore({
        executor: txExecutor,
        tableName: options.historyTable,
      }),
  });

  return Promise.resolve(
    new SisalMysqlMigrator({
      driver,
      store,
      logger: options.logger,
      logging: options.logging,
      useTransaction: options.useTransaction ?? false,
      splitStatements: options.splitStatements ?? false,
    }),
  );
}

class SisalMysqlMigrator implements MysqlMigrator {
  readonly #driver: ReturnType<typeof createMysqlMigrationDriver>;
  readonly #store: ReturnType<typeof createMysqlMigrationHistoryStore>;
  readonly #logger?: Logger;
  readonly #logging?: SisalLoggingOptions;
  readonly #useTransaction: boolean;
  readonly #splitStatements: boolean;

  constructor(options: {
    readonly driver: ReturnType<typeof createMysqlMigrationDriver>;
    readonly store: ReturnType<typeof createMysqlMigrationHistoryStore>;
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

  migrate(options: MysqlMigrateOptions): Promise<MigrationResult> {
    return this.#createCoreMigrator(options.migrations).up(options);
  }

  rollback(options: MysqlRollbackOptions): Promise<MigrationResult> {
    return this.#createCoreMigrator(options.migrations).down(options);
  }

  plan(options: MysqlMigrationPlanOptions): Promise<MigrationPlan> {
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

  #createCoreMigrator(migrations: readonly MysqlMigrationInput[]) {
    return createMigrator({
      migrations: normalizeMysqlMigrations(migrations),
      store: this.#store,
      driver: this.#driver,
      logger: this.#logger,
      ...(this.#logging === undefined ? {} : { logging: this.#logging }),
      useTransaction: this.#useTransaction,
      splitStatements: this.#splitStatements,
    });
  }
}

function normalizeMysqlMigrations(
  migrations: readonly MysqlMigrationInput[],
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
  migration: MysqlMigrationInput,
): migration is Migration {
  return migration.kind === "sql" || migration.kind === "programmatic";
}
