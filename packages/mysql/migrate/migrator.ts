/**
 * MySQL/MariaDB migration facade over the core `@sisal/migrate` migrator.
 *
 * @module
 */

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

import type { MysqlConnectionOptions } from "../orm/pool.ts";
import { createMysqlMigrationDriver } from "./driver.ts";
import { createMysqlMigrateExecutor, type SqlExecutor } from "./executor.ts";
import { createMysqlMigrationHistoryStore } from "./history.ts";

/** MySQL convenience migration definition with inferred programmatic kind. */
export interface MysqlMigrationDefinition extends MigrationBase {
  readonly kind?: never;
  readonly up: MigrationStep;
  readonly down?: MigrationStep;
}

/** Migration input accepted by the MySQL migrator facade. */
export type MysqlMigrationInput = Migration | MysqlMigrationDefinition;

/** Options for applying pending MySQL migrations. */
export interface MysqlMigrateOptions extends MigrationRunOptions {
  readonly migrations: readonly MysqlMigrationInput[];
}

/** Options for rolling back MySQL migrations. */
export interface MysqlRollbackOptions extends MigrationDownOptions {
  readonly migrations: readonly MysqlMigrationInput[];
}

/** Options for planning MySQL migrations without executing them. */
export interface MysqlMigrationPlanOptions {
  readonly migrations: readonly MysqlMigrationInput[];
}

/** MySQL migration facade backed by the core migrator. */
export interface MysqlMigrator {
  migrate(options: MysqlMigrateOptions): Promise<MigrationResult>;
  rollback(options: MysqlRollbackOptions): Promise<MigrationResult>;
  plan(options: MysqlMigrationPlanOptions): Promise<MigrationPlan>;
  applied(): Promise<AppliedMigration[]>;
  close(): Promise<void>;
}

/** Options for creating a MySQL migration facade. */
export interface CreateMysqlMigratorOptions extends MysqlConnectionOptions {
  readonly executor?: SqlExecutor;
  readonly logger?: Logger;
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
      useTransaction: options.useTransaction ?? false,
      splitStatements: options.splitStatements ?? false,
    }),
  );
}

class SisalMysqlMigrator implements MysqlMigrator {
  readonly #driver: ReturnType<typeof createMysqlMigrationDriver>;
  readonly #store: ReturnType<typeof createMysqlMigrationHistoryStore>;
  readonly #logger?: Logger;
  readonly #useTransaction: boolean;
  readonly #splitStatements: boolean;

  constructor(options: {
    readonly driver: ReturnType<typeof createMysqlMigrationDriver>;
    readonly store: ReturnType<typeof createMysqlMigrationHistoryStore>;
    readonly logger?: Logger;
    readonly useTransaction: boolean;
    readonly splitStatements: boolean;
  }) {
    this.#driver = options.driver;
    this.#store = options.store;
    this.#logger = options.logger;
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

  #createCoreMigrator(migrations: readonly MysqlMigrationInput[]) {
    return createMigrator({
      migrations: normalizeMysqlMigrations(migrations),
      store: this.#store,
      driver: this.#driver,
      logger: this.#logger,
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
