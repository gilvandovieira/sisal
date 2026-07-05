/**
 * MySQL/MariaDB adapter for `@sisal/orm`.
 *
 * Provides MySQL query execution, connection pooling, dialect wiring, and a
 * database facade backed by `mysql2/promise`-compatible clients (imported
 * lazily). One adapter serves both engines per the v0.6 readiness decision
 * (`docs/mysql-readiness.md`): MySQL ≥ 8.0.16 is the baseline and MariaDB ≥
 * 10.10 rides the same adapter, with variant-gated capabilities expressed
 * through the `(engine, variant, version)` dialect identity — filled
 * automatically by {@link connect} from `select version()` (or passed
 * explicitly as `variant`/`version`).
 *
 * @module
 */

import type {
  Logger,
  SisalLoggingOptions,
  TemporalParsingOptions,
} from "@sisal/orm";

import {
  createDatabase,
  type Database,
  type MappableQueryResult,
  type OrmQueryResult,
  type SqlInput,
  type SqlParameter,
} from "@sisal/orm";

import { MYSQL_DIALECT } from "./dialect.ts";
import { createMysqlOrmDriver, type MysqlOrmDriverOptions } from "./driver.ts";
import { createMysqlExecutor } from "./executor.ts";
import { parseMysqlServerVersion } from "./version.ts";

export type { MysqlQueryResult, MysqlSqlExecutor } from "./executor.ts";
export { createMysqlExecutor } from "./executor.ts";
export { MARIADB_VARIANT, MYSQL_DIALECT } from "./dialect.ts";
export { createMysqlOrmDriver } from "./driver.ts";
export type { MysqlOrmDriverOptions } from "./driver.ts";
export type {
  MysqlClient,
  MysqlConnectionOptions,
  MysqlDriverKind,
  MysqlDriverRows,
  MysqlPool,
  MysqlResultHeader,
  MysqlTlsOptions,
} from "./pool.ts";
export { createMysqlPool } from "./pool.ts";
export { adaptMariadbPool, createMariadbPool } from "./mariadb_pool.ts";
export { parseMysqlServerVersion } from "./version.ts";
export type { MysqlServerIdentity } from "./version.ts";
export { insertReturning } from "./returning.ts";

/** MySQL/MariaDB-specialized database facade. */
export interface MysqlDatabase extends Database {
  /** Executes SQL through this mysql database. */
  execute<T = unknown>(
    query: SqlInput,
    params?: readonly SqlParameter[],
  ): Promise<OrmQueryResult<T>>;
  /** Runs a query through this mysql database. */

  query<T = unknown>(
    query: SqlInput,
    params?: readonly SqlParameter[],
  ): MappableQueryResult<T>;
}

/** Options for opening a MySQL/MariaDB-backed database facade. */
export interface CreateMysqlDbOptions extends MysqlOrmDriverOptions {
  /** Logging options used by this create mysql db options. */
  readonly logger?: Logger;
  /** Temporal parsing options used by this create mysql db options. */
  readonly logging?: SisalLoggingOptions;
  /** Temporal parsing options used by this create mysql db options. */
  readonly temporal?: TemporalParsingOptions;
  /**
   * Engine variant behind the connection (e.g. {@link MARIADB_VARIANT}).
   * Together with `version` this fills the facade's `dialectIdentity`, which
   * is what lets version-gated capabilities (MariaDB `INSERT`/`DELETE …
   * RETURNING`) render instead of throwing their typed guards. Setting it
   * explicitly skips auto-detection.
   */
  readonly variant?: string;
  /** Server version string (e.g. `"11.8.8-MariaDB"`); see `variant`. */
  readonly version?: string;
  /**
   * Whether {@link connect} runs `select version()` once to fill the
   * `dialectIdentity` from the live server. Defaults to `true` when
   * connecting to a real source (`url`/`pool`/`client`) without an explicit
   * `variant`/`version`, and `false` when an `executor` is injected (the
   * network-free test seam). Set `false` for a fully lazy connect — the
   * identity then stays "base MySQL, version unknown", which keeps every
   * version-gated capability guarded (fail closed).
   */
  readonly detectVersion?: boolean;
}

/** Opens a MySQL/MariaDB-backed database facade. */
export async function createMysqlDb(
  options: CreateMysqlDbOptions,
): Promise<MysqlDatabase> {
  const executor = createMysqlExecutor(options);

  let variant = options.variant;
  let version = options.version;
  const detect = options.detectVersion ??
    (options.executor === undefined && variant === undefined &&
      version === undefined);
  if (detect) {
    const result = await executor.execute<{ v: unknown }>(
      "select version() as v",
    );
    const raw = result.rows[0]?.v;
    if (typeof raw === "string" && raw.length > 0) {
      const identity = parseMysqlServerVersion(raw);
      variant = identity.variant;
      version = identity.version;
    }
  }

  const driver = createMysqlOrmDriver({ executor });

  return createDatabase({
    driver,
    dialect: MYSQL_DIALECT,
    ...(variant === undefined ? {} : { variant }),
    ...(version === undefined ? {} : { version }),
    logger: options.logger,
    logging: options.logging,
    temporal: options.temporal,
  }) as MysqlDatabase;
}

/** Convenience alias for {@link createMysqlDb} — opens a MySQL-backed database. */
export function connect(
  options: CreateMysqlDbOptions,
): Promise<MysqlDatabase> {
  return createMysqlDb(options);
}
