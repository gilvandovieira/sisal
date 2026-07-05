/**
 * Migration definitions, planning, history stores, and runner contracts.
 *
 * @module
 */

import { createSisalLogEmitter, SisalError } from "@sisal/core";
import type {
  Logger,
  SisalLogCategory,
  SisalLogEmitter,
  SisalLoggingOptions,
  SisalLogSettings,
} from "@sisal/core";
import {
  assertValidSchemaSnapshot,
  diffSchemaSnapshots,
  normalizeSchemaSnapshot,
  SCHEMA_SNAPSHOT_VERSION,
  type SisalSchemaSnapshot,
  type SisalSchemaSnapshotDiff,
} from "@sisal/core";

import { splitSqlStatements } from "./sql_split.ts";

export * from "./workflow.ts";
export * from "./sql_split.ts";

const DEFAULT_LOCK_ID = "sisal:migrate";

/** Error codes emitted by migration validation, planning, locking, and execution. */
export type MigrationErrorCode =
  | "MIGRATION_INVALID"
  | "MIGRATION_DUPLICATE_ID"
  | "MIGRATION_CHECKSUM_MISMATCH"
  | "MIGRATION_LOCK_FAILED"
  | "MIGRATION_UNLOCK_FAILED"
  | "MIGRATION_EXECUTE_FAILED"
  | "MIGRATION_ROLLBACK_FAILED"
  | "MIGRATION_MARK_APPLIED_FAILED"
  | "MIGRATION_UNMARK_APPLIED_FAILED"
  | "MIGRATION_DRIVER_MISSING"
  | "MIGRATION_STORE_MISSING"
  | "MIGRATION_UNKNOWN_ERROR"
  | (string & Record<never, never>);

/** Stable migration identifier, usually derived from a migration file name. */
export type MigrationId = string;

/** Direction a migration runner is executing. */
export type MigrationDirection = "up" | "down";

/** Planning or execution status for a migration. */
export type MigrationStatus =
  | "pending"
  | "applied"
  | "rolled_back"
  | "failed"
  | "skipped";

/** Supported migration definition shapes. */
export type MigrationKind = "sql" | "programmatic";

/** Deterministic checksum used to detect edited migrations. */
export type MigrationChecksum = string;

/** Context passed to programmatic migrations. */
export interface MigrationContext {
  /** Logger used by this migration context. */
  readonly driver: MigrationDriver;
  /** Logging options used by this migration context. */
  readonly logger?: Logger;
  /** dry run for this migration context. */
  readonly logging?: SisalLogSettings;
  /** Sort or migration direction for this migration context. */
  readonly dryRun: boolean;
  /** Sort or migration direction for this migration context. */
  readonly direction: MigrationDirection;
}

/** Minimal async driver contract for future database adapters. */
export interface MigrationDriver {
  /** Executes SQL through this migration driver. */
  execute(sql: string): Promise<void>;
  /** Runs work inside a transaction for this migration driver. */

  transaction?<T>(
    fn: (tx: MigrationTransaction) => Promise<T>,
  ): Promise<T>;
  /** Closes resources held by this migration driver. */

  close?(): Promise<void>;
}

/** Driver/store scope exposed to migration transaction callbacks. */
export interface MigrationTransaction {
  /** Migration store used by this migration transaction. */
  readonly driver: MigrationDriver;
  /** Migration store used by this migration transaction. */
  readonly store?: MigrationStore;
}

/** Executable migration step, either SQL text or a programmatic callback. */
export type MigrationStep =
  | string
  | readonly string[]
  | ((ctx: MigrationContext) => void | Promise<void>);

/** Common metadata shared by all migration definitions. */
export interface MigrationBase {
  /** description for this migration base. */
  readonly id: MigrationId;
  /** checksum for this migration base. */
  readonly description?: string;
  /** created at for this migration base. */
  readonly checksum?: MigrationChecksum;
  /** created at for this migration base. */
  readonly createdAt?: string;
}

/** SQL migration definition. */
export interface SqlMigration extends MigrationBase {
  /** Forward migration SQL or callback for this sql migration. */
  readonly kind: "sql";
  /** Rollback SQL or callback for this sql migration. */
  readonly up: string;
  /** Rollback SQL or callback for this sql migration. */
  readonly down?: string;
}

/** Programmatic migration definition. */
export interface ProgrammaticMigration extends MigrationBase {
  /** Forward migration SQL or callback for this programmatic migration. */
  readonly kind: "programmatic";
  /** Rollback SQL or callback for this programmatic migration. */
  readonly up: MigrationStep;
  /** Rollback SQL or callback for this programmatic migration. */
  readonly down?: MigrationStep;
}

/** Any migration definition accepted by a Sisal migrator. */
export type Migration = SqlMigration | ProgrammaticMigration;

/** Applied migration history record. */
export interface AppliedMigration {
  /** checksum for this applied migration. */
  readonly id: MigrationId;
  /** applied at for this applied migration. */
  readonly checksum: MigrationChecksum;
  /** Execution duration for this applied migration, in milliseconds. */
  readonly appliedAt: string;
  /** description for this applied migration. */
  readonly executionMs?: number;
  /** description for this applied migration. */
  readonly description?: string;
}

/** One migration's status inside a generated migration plan. */
export interface MigrationPlanItem {
  /** HTTP-style status associated with this migration plan item. */
  readonly migration: Migration;
  /** checksum for this migration plan item. */
  readonly status: MigrationStatus;
  /** Lists applied migrations for this migration plan item. */
  readonly checksum: MigrationChecksum;
  /** reason for this migration plan item. */
  readonly applied?: AppliedMigration;
  /** reason for this migration plan item. */
  readonly reason?: string;
}

/** Full migration plan grouped by pending, applied, and mismatched entries. */
export interface MigrationPlan {
  /** Pending entries in this migration plan. */
  readonly items: MigrationPlanItem[];
  /** Lists applied migrations for this migration plan. */
  readonly pending: MigrationPlanItem[];
  /** checksum mismatches for this migration plan. */
  readonly applied: MigrationPlanItem[];
  /** Whether has pending applies to this migration plan. */
  readonly checksumMismatches: MigrationPlanItem[];
  /** Whether has checksum mismatches applies to this migration plan. */
  readonly hasPending: boolean;
  /** Whether has checksum mismatches applies to this migration plan. */
  readonly hasChecksumMismatches: boolean;
}

/** Result returned after applying or rolling back migrations. */
export interface MigrationResult {
  /** dry run for this migration result. */
  readonly direction: MigrationDirection;
  /** executed for this migration result. */
  readonly dryRun: boolean;
  /** Skipped entries in this migration result. */
  readonly executed: AppliedMigration[];
  /** Failed entries in this migration result. */
  readonly skipped: MigrationId[];
  /** Failed entries in this migration result. */
  readonly failed?: {
    readonly id: MigrationId;
    readonly error: unknown;
    /** Execution duration for this migration result, in milliseconds. */
  };
  /** Execution duration for this migration result, in milliseconds. */
  readonly executionMs: number;
}

/** Options for applying pending migrations. */
export interface MigrationRunOptions {
  /** steps for this migration run options. */
  readonly dryRun?: boolean;
  /** Whether allow dirty applies to this migration run options. */
  readonly steps?: number;
  /** Whether allow dirty applies to this migration run options. */
  readonly allowDirty?: boolean;
}

/** Options for rolling back applied migrations. */
export interface MigrationDownOptions extends MigrationRunOptions {
  /** to for this migration down options. */
  readonly to?: MigrationId;
}

/** Async-first store for applied migration history and optional locks. */
export interface MigrationStore {
  /** Lists migrations recorded by this migration store. */
  listApplied(): Promise<AppliedMigration[]>;
  /** Looks up one applied migration in this migration store. */

  getApplied(
    id: MigrationId,
  ): Promise<AppliedMigration | undefined>;
  /** Records an applied migration in this migration store. */

  markApplied(
    migration: AppliedMigration,
  ): Promise<void>;
  /** Removes an applied migration record from this migration store. */

  unmarkApplied(
    id: MigrationId,
  ): Promise<boolean>;
  /** acquire lock for this migration store. */

  acquireLock?(
    lockId?: string,
  ): Promise<boolean>;
  /** release lock for this migration store. */

  releaseLock?(
    lockId?: string,
  ): Promise<void>;
  /** clear for this migration store. */

  clear?(): Promise<void>;
  /** Closes resources held by this migration store. */

  close?(): Promise<void>;
}

/** Public migration runner. */
export interface Migrator {
  /** Builds a migration plan for this migrator. */
  plan(): Promise<MigrationPlan>;
  /** Forward migration SQL or callback for this migrator. */

  up(
    options?: MigrationRunOptions,
  ): Promise<MigrationResult>;
  /** Rollback SQL or callback for this migrator. */

  down(
    options?: MigrationDownOptions,
  ): Promise<MigrationResult>;
  /** Pending entries in this migrator. */

  pending(): Promise<Migration[]>;
  /** Lists applied migrations for this migrator. */

  applied(): Promise<AppliedMigration[]>;
  /** Closes resources held by this migrator. */

  close(): Promise<void>;

  /**
   * Async-disposal alias for {@link close}, so
   * `await using migrator = createMigrator(...)` releases the store and driver
   * when the scope exits — including on an early return or a throw.
   */
  [Symbol.asyncDispose](): Promise<void>;
}

/** Options for creating a core {@link Migrator}. */
export interface MigratorOptions {
  /** Migration store used by this migrator options. */
  readonly migrations: Migration[];
  /** Driver used by this migrator options. */
  readonly store?: MigrationStore;
  /** Logger used by this migrator options. */
  readonly driver?: MigrationDriver;
  /** Logging options used by this migrator options. */
  readonly logger?: Logger;
  /** lock id for this migrator options. */
  readonly logging?: SisalLoggingOptions;
  /** Transaction behavior for this migrator options. */
  readonly lockId?: string;
  /** Transaction behavior for this migrator options. */
  readonly useTransaction?: boolean;
  /**
   * Apply each SQL migration **statement-by-statement** instead of as one
   * multi-statement query. A string `up`/`down` step is split with
   * {@link splitSqlStatements} (dollar-quote/string/comment aware) and each
   * statement runs as a separate `driver.execute(...)` call. Required for
   * drivers that accept only one statement per call (e.g. PostgreSQL's
   * serverless/HTTP transports). Array steps already run per-statement and are
   * left untouched. Defaults to `false`.
   */
  readonly splitStatements?: boolean;
}

/** Input snapshots for creating a schema migration plan. */
export interface SchemaMigrationPlanInput {
  /** to for this schema migration plan input. */
  readonly from?: SisalSchemaSnapshot;
  /** to for this schema migration plan input. */
  readonly to: SisalSchemaSnapshot;
}

/** Normalized schema migration plan snapshot pair. */
export interface SchemaMigrationPlan {
  /** to for this schema migration plan. */
  readonly from?: SisalSchemaSnapshot;
  /** to for this schema migration plan. */
  readonly to: SisalSchemaSnapshot;
}

/** Options for the in-memory migration history store. */
export interface MemoryMigrationStoreOptions {
  /** locked for this memory migration store options. */
  readonly applied?: AppliedMigration[];
  /** clone values for this memory migration store options. */
  readonly locked?: boolean;
  /** clone values for this memory migration store options. */
  readonly cloneValues?: boolean;
}

/** Options accepted when constructing a {@link MigrationError}. */
export interface MigrationErrorOptions {
  /** HTTP-style status associated with this migration error options. */
  readonly code?: MigrationErrorCode;
  /** Whether this migration error options can be shown to callers. */
  readonly status?: number;
  /** Severity level associated with this migration error options. */
  readonly expose?: boolean;
  /** Structured diagnostic details for this migration error options. */
  readonly severity?: "debug" | "info" | "warn" | "error" | "fatal";
  /** Original cause associated with this migration error options. */
  readonly details?: Record<string, unknown>;
  /** Original cause associated with this migration error options. */
  readonly cause?: unknown;
}

/** Error thrown for migration validation, planning, locking, and execution. */
export class MigrationError extends SisalError {
  /** Creates a migration error. */
  constructor(message: string, options: MigrationErrorOptions = {}) {
    super(message, {
      code: options.code ?? "MIGRATION_UNKNOWN_ERROR",
      status: options.status ?? 500,
      expose: options.expose ?? false,
      severity: options.severity ?? "error",
      details: options.details,
      cause: options.cause,
    });
  }
}

/** Defines a programmatic migration and validates its public shape. */
export function defineMigration(
  options: Omit<ProgrammaticMigration, "kind">,
): ProgrammaticMigration {
  const migration: ProgrammaticMigration = {
    ...options,
    kind: "programmatic",
  };

  validateMigration(migration);
  return migration;
}

/** Defines a SQL migration and validates its public shape. */
export function defineSqlMigration(
  options: Omit<SqlMigration, "kind">,
): SqlMigration {
  const migration: SqlMigration = {
    ...options,
    kind: "sql",
  };

  validateMigration(migration);
  return migration;
}

/** Creates a migrator with memory store and noop driver defaults. */
export function createMigrator(options: MigratorOptions): Migrator {
  validateMigrations(options.migrations);

  return new SisalMigrator({
    migrations: sortMigrations(options.migrations),
    store: options.store ?? memoryMigrationStore(),
    driver: options.driver ?? noopMigrationDriver(),
    logger: options.logger,
    ...(options.logging === undefined ? {} : { logging: options.logging }),
    lockId: options.lockId ?? DEFAULT_LOCK_ID,
    useTransaction: options.useTransaction ?? true,
    splitStatements: options.splitStatements ?? false,
  });
}

/** Creates an in-memory migration history store for tests and scaffolding. */
export function memoryMigrationStore(
  options: MemoryMigrationStoreOptions = {},
): MigrationStore {
  const applied = new Map<MigrationId, AppliedMigration>();
  let locked = options.locked ?? false;
  const cloneValues = options.cloneValues ?? false;

  for (const migration of options.applied ?? []) {
    const cloned = cloneAppliedMigration(migration, cloneValues);
    applied.set(cloned.id, cloned);
  }

  return {
    listApplied(): Promise<AppliedMigration[]> {
      const migrations = [...applied.values()]
        .map((migration) => cloneAppliedMigration(migration, cloneValues))
        .sort((a, b) => a.id.localeCompare(b.id));

      return Promise.resolve(migrations);
    },

    getApplied(id: MigrationId): Promise<AppliedMigration | undefined> {
      const migration = applied.get(normalizeMigrationId(id));

      return Promise.resolve(
        migration === undefined
          ? undefined
          : cloneAppliedMigration(migration, cloneValues),
      );
    },

    markApplied(migration: AppliedMigration): Promise<void> {
      const cloned = cloneAppliedMigration(migration, cloneValues);
      applied.set(cloned.id, cloned);
      return Promise.resolve();
    },

    unmarkApplied(id: MigrationId): Promise<boolean> {
      return Promise.resolve(applied.delete(normalizeMigrationId(id)));
    },

    acquireLock(_lockId?: string): Promise<boolean> {
      if (locked) {
        return Promise.resolve(false);
      }

      locked = true;
      return Promise.resolve(true);
    },

    releaseLock(_lockId?: string): Promise<void> {
      locked = false;
      return Promise.resolve();
    },

    clear(): Promise<void> {
      applied.clear();
      locked = false;
      return Promise.resolve();
    },

    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}

/** Creates a plan from known migrations and applied history. */
export function createMigrationPlan(
  migrations: Migration[],
  applied: AppliedMigration[],
): MigrationPlan {
  validateMigrations(migrations);
  const sortedMigrations = sortMigrations(migrations);
  const appliedById = new Map<MigrationId, AppliedMigration>();

  for (const migration of applied) {
    appliedById.set(normalizeMigrationId(migration.id), migration);
  }

  const items: MigrationPlanItem[] = sortedMigrations.map((migration) => {
    const checksum = getMigrationChecksum(migration);
    const appliedMigration = appliedById.get(migration.id);

    if (appliedMigration === undefined) {
      return {
        migration,
        status: "pending",
        checksum,
        reason: "Migration has not been applied",
      };
    }

    if (appliedMigration.checksum !== checksum) {
      return {
        migration,
        status: "applied",
        checksum,
        applied: appliedMigration,
        reason: "Applied migration checksum differs from current migration",
      };
    }

    return {
      migration,
      status: "applied",
      checksum,
      applied: appliedMigration,
    };
  });

  const pending = items.filter((item) => item.status === "pending");
  const appliedItems = items.filter((item) => item.status === "applied");
  const checksumMismatches = items.filter((item) =>
    item.applied !== undefined && item.applied.checksum !== item.checksum
  );

  return {
    items,
    pending,
    applied: appliedItems,
    checksumMismatches,
    hasPending: pending.length > 0,
    hasChecksumMismatches: checksumMismatches.length > 0,
  };
}

/** Accepts validated schema snapshots as metadata for future diffing. */
export function defineSchemaMigrationPlan(
  input: SchemaMigrationPlanInput,
): SchemaMigrationPlan {
  const from = input.from === undefined
    ? undefined
    : normalizeSchemaSnapshot(input.from);
  const to = normalizeSchemaSnapshot(input.to);

  if (from !== undefined) {
    assertValidSchemaSnapshot(from);
  }

  assertValidSchemaSnapshot(to);

  return {
    ...(from === undefined ? {} : { from }),
    to,
  };
}

/** A single structural change between two schema snapshots. */
export type SchemaChangeKind =
  | "create_table"
  | "drop_table"
  | "add_column"
  | "drop_column"
  | "alter_column";

/** One classified schema change, with a destructiveness flag. */
export interface SchemaChange {
  /** table for this schema change. */
  readonly kind: SchemaChangeKind;
  /** schema for this schema change. */
  readonly table: string;
  /** column for this schema change. */
  readonly schema?: string;
  /** column for this schema change. */
  readonly column?: string;
  /** True when applying the change can lose data (drop/alter). */
  readonly destructive: boolean;
}

/** Result of {@link planSchemaChanges}: an ordered, classified change list. */
export interface SchemaMigrationChanges {
  /** Whether this schema migration changes includes destructive changes. */
  readonly changes: readonly SchemaChange[];
  /** Whether is empty applies to this schema migration changes. */
  readonly destructive: readonly SchemaChange[];
  /** Whether is empty applies to this schema migration changes. */
  readonly isEmpty: boolean;
}

const EMPTY_SCHEMA_SNAPSHOT: SisalSchemaSnapshot = {
  version: SCHEMA_SNAPSHOT_VERSION,
  tables: [],
};

/**
 * Classifies the changes from one schema snapshot to another into ordered
 * {@link SchemaChange}s, flagging destructive operations (drop table/column and
 * column type changes). A missing `from` treats every table as newly created.
 *
 * This builds on the schema snapshot helpers exported by `@sisal/core`.
 * `@sisal/migrate` consumes snapshots; it does not create table metadata or
 * depend on any database adapter.
 */
export function planSchemaChanges(
  input: SchemaMigrationPlanInput,
): SchemaMigrationChanges {
  const plan = defineSchemaMigrationPlan(input);
  const diff = diffSchemaSnapshots(plan.from ?? EMPTY_SCHEMA_SNAPSHOT, plan.to);
  return planSchemaChangesFromDiff(diff);
}

/**
 * Classifies an already-computed {@link SisalSchemaSnapshotDiff} into ordered
 * {@link SchemaChange}s. Use this when you already hold a diff and want to avoid
 * recomputing it — generated DDL, for example, iterates the diff for statements
 * and reuses the same diff here for the destructive list, rather than diffing
 * twice via {@link planSchemaChanges}.
 */
export function planSchemaChangesFromDiff(
  diff: SisalSchemaSnapshotDiff,
): SchemaMigrationChanges {
  const changes: SchemaChange[] = [];

  for (const table of diff.addedTables) {
    changes.push(schemaChange("create_table", table, undefined, false));
  }

  for (const table of diff.changedTables) {
    for (const column of table.columns.added) {
      changes.push(schemaChange("add_column", table, column.name, false));
    }
    for (const column of table.columns.changed) {
      changes.push(schemaChange("alter_column", table, column.name, true));
    }
    for (const column of table.columns.removed) {
      changes.push(schemaChange("drop_column", table, column.name, true));
    }
  }

  for (const table of diff.removedTables) {
    changes.push(schemaChange("drop_table", table, undefined, true));
  }

  return {
    changes,
    destructive: changes.filter((change) => change.destructive),
    isEmpty: changes.length === 0,
  };
}

function schemaChange(
  kind: SchemaChangeKind,
  table: { readonly name: string; readonly schema?: string },
  column: string | undefined,
  destructive: boolean,
): SchemaChange {
  return {
    kind,
    table: table.name,
    ...(table.schema === undefined ? {} : { schema: table.schema }),
    ...(column === undefined ? {} : { column }),
    destructive,
  };
}

/**
 * Builds a zero-padded, slugged migration filename such as
 * `0002_create_users.sql`. The sequence is padded to at least 4 digits.
 */
export function formatMigrationFilename(
  sequence: number,
  name: string,
  extension = "sql",
): string {
  const id = String(Math.max(0, Math.trunc(sequence))).padStart(4, "0");
  const slug = slugifyMigrationName(name);
  return slug.length === 0
    ? `${id}.${extension}`
    : `${id}_${slug}.${extension}`;
}

/** Lowercases a migration name into an underscore slug (`Add Users` → `add_users`). */
export function slugifyMigrationName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Returns a new migration list sorted by id. */
export function sortMigrations(migrations: Migration[]): Migration[] {
  return [...migrations].sort((a, b) => a.id.localeCompare(b.id));
}

/** Validates one migration definition. */
export function validateMigration(migration: Migration): void {
  if (typeof migration !== "object" || migration === null) {
    throwInvalidMigration("Migration must be an object");
  }

  normalizeMigrationId(migration.id);
  const migrationKind = (migration as { readonly kind?: unknown }).kind;

  if (migrationKind !== "sql" && migrationKind !== "programmatic") {
    throwInvalidMigration("Migration kind must be sql or programmatic", {
      id: migration.id,
    });
  }

  if (migration.createdAt !== undefined) {
    toIsoString(migration.createdAt, "createdAt");
  }

  if (migration.checksum !== undefined) {
    normalizeChecksum(migration.checksum);
  }

  if (migration.kind === "sql") {
    assertNonEmptyString(migration.up, "up", migration.id);

    if (migration.down !== undefined) {
      assertNonEmptyString(migration.down, "down", migration.id);
    }

    return;
  }

  validateMigrationStep(migration.up, "up", migration.id);

  if (migration.down !== undefined) {
    validateMigrationStep(migration.down, "down", migration.id);
  }
}

/** Validates a migration list and rejects duplicate ids. */
export function validateMigrations(migrations: Migration[]): void {
  if (!Array.isArray(migrations)) {
    throw new MigrationError("Migrations must be an array", {
      code: "MIGRATION_INVALID",
    });
  }

  const seen = new Set<MigrationId>();

  for (const migration of migrations) {
    validateMigration(migration);

    if (seen.has(migration.id)) {
      throw new MigrationError("Duplicate migration id", {
        code: "MIGRATION_DUPLICATE_ID",
        details: { id: migration.id },
      });
    }

    seen.add(migration.id);
  }
}

/** Calculates a deterministic non-cryptographic checksum for a migration. */
export function calculateMigrationChecksum(
  migration: Migration,
): MigrationChecksum {
  validateMigration(migration);

  const input = [
    migration.id,
    migration.kind,
    normalizeChecksumText(migrationStepToString(migration.up)),
    migration.down === undefined
      ? ""
      : normalizeChecksumText(migrationStepToString(migration.down)),
  ].join("\n");

  return `migr_${hashString(input)}`;
}

/**
 * Normalizes migration text before hashing so the same `.sql` file produces the
 * same checksum across platforms: CRLF/CR become LF, trailing whitespace is
 * stripped per line, and trailing blank lines are dropped.
 */
function normalizeChecksumText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .replace(/\n+$/u, "");
}

/** Throws when an applied migration checksum differs from the current one. */
export function assertMigrationChecksum(
  applied: AppliedMigration,
  migration: Migration,
): void {
  const expected = applied.checksum;
  const actual = getMigrationChecksum(migration);

  if (expected !== actual) {
    throw new MigrationError("Migration checksum mismatch", {
      code: "MIGRATION_CHECKSUM_MISMATCH",
      details: {
        id: migration.id,
        expected,
        actual,
      },
    });
  }
}

/** Creates an applied migration history record. */
export function createAppliedMigration(
  migration: Migration,
  options: {
    readonly appliedAt?: Date | string | number;
    readonly executionMs?: number;
  } = {},
): AppliedMigration {
  validateMigration(migration);
  const appliedAt = toIsoString(options.appliedAt ?? new Date(), "appliedAt");
  const executionMs = options.executionMs === undefined
    ? undefined
    : normalizeNonNegativeNumber(options.executionMs, "executionMs");

  return {
    id: migration.id,
    checksum: getMigrationChecksum(migration),
    appliedAt,
    ...(executionMs === undefined ? {} : { executionMs }),
    ...(migration.description === undefined
      ? {}
      : { description: migration.description }),
  };
}

/** Returns true if a migration id exists in applied history. */
export function isMigrationApplied(
  migration: Migration,
  applied: AppliedMigration[],
): boolean {
  return applied.some((item) => item.id === migration.id);
}

/** Returns migrations that are not present in applied history. */
export function getPendingMigrations(
  migrations: Migration[],
  applied: AppliedMigration[],
): Migration[] {
  const appliedIds = new Set(applied.map((migration) => migration.id));

  return sortMigrations(migrations).filter((migration) =>
    !appliedIds.has(migration.id)
  );
}

/** Returns applied history for migrations known to the current codebase. */
export function getAppliedMigrations(
  migrations: Migration[],
  applied: AppliedMigration[],
): AppliedMigration[] {
  const knownIds = new Set(migrations.map((migration) => migration.id));

  return applied
    .filter((migration) => knownIds.has(migration.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Returns known applied migrations in rollback order. */
export function getRollbackMigrations(
  migrations: Migration[],
  applied: AppliedMigration[],
  steps?: number,
): Migration[] {
  const knownAppliedIds = new Set(applied.map((migration) => migration.id));
  const rollbackMigrations = sortMigrations(migrations)
    .filter((migration) => knownAppliedIds.has(migration.id))
    .reverse();
  const normalizedSteps = normalizeOptionalSteps(steps);

  return normalizedSteps === undefined
    ? rollbackMigrations
    : rollbackMigrations.slice(0, normalizedSteps);
}

/**
 * Creates a noop driver.
 *
 * It never executes a real database operation and is intended for dry-runs,
 * tests, and scaffolding only.
 */
export function noopMigrationDriver(): MigrationDriver {
  const driver: MigrationDriver = {
    execute(_sql: string): Promise<void> {
      return Promise.resolve();
    },

    transaction<T>(fn: (tx: MigrationTransaction) => Promise<T>): Promise<T> {
      return fn({ driver });
    },

    close(): Promise<void> {
      return Promise.resolve();
    },
  };

  return driver;
}

/** Creates a migrator that reports no migrations and executes nothing. */
export function noopMigrator(): Migrator {
  const migrator: Migrator = {
    plan(): Promise<MigrationPlan> {
      return Promise.resolve(createMigrationPlan([], []));
    },

    up(options: MigrationRunOptions = {}): Promise<MigrationResult> {
      return Promise.resolve({
        direction: "up",
        dryRun: options.dryRun ?? false,
        executed: [],
        skipped: [],
        executionMs: 0,
      });
    },

    down(options: MigrationDownOptions = {}): Promise<MigrationResult> {
      return Promise.resolve({
        direction: "down",
        dryRun: options.dryRun ?? false,
        executed: [],
        skipped: [],
        executionMs: 0,
      });
    },

    pending(): Promise<Migration[]> {
      return Promise.resolve([]);
    },

    applied(): Promise<AppliedMigration[]> {
      return Promise.resolve([]);
    },

    close(): Promise<void> {
      return Promise.resolve();
    },

    [Symbol.asyncDispose](): Promise<void> {
      return migrator.close();
    },
  };

  return migrator;
}

interface SisalMigratorOptions {
  readonly migrations: Migration[];
  readonly store: MigrationStore;
  readonly driver: MigrationDriver;
  readonly logger?: Logger;
  readonly logging?: SisalLoggingOptions;
  readonly log?: SisalLogEmitter;
  readonly lockId: string;
  readonly useTransaction: boolean;
  readonly splitStatements: boolean;
}

class SisalMigrator implements Migrator {
  readonly #migrations: Migration[];
  readonly #store: MigrationStore;
  readonly #driver: MigrationDriver;
  readonly #log: SisalLogEmitter;
  readonly #lockId: string;
  readonly #useTransaction: boolean;
  readonly #splitStatements: boolean;

  constructor(options: SisalMigratorOptions) {
    this.#migrations = options.migrations;
    this.#store = options.store;
    this.#driver = options.driver;
    this.#log = options.log ?? createSisalLogEmitter({
      logger: options.logger,
      logging: options.logging,
      defaultLevel: "debug",
      metadata: options.logging !== undefined,
    });
    this.#lockId = options.lockId;
    this.#useTransaction = options.useTransaction;
    this.#splitStatements = options.splitStatements;
  }

  // Splits a string SQL step into per-statement form when splitStatements is on;
  // array/function steps already run statement-by-statement.
  #resolveStep(step: MigrationStep): MigrationStep {
    return this.#splitStatements && typeof step === "string"
      ? splitSqlStatements(step)
      : step;
  }

  async plan(): Promise<MigrationPlan> {
    this.#debug("migrate.plan", undefined, "migration plan started");
    const applied = await this.#store.listApplied();
    const plan = createMigrationPlan(this.#migrations, applied);
    this.#debug(
      "migrate.plan",
      { pending: plan.pending.length, applied: plan.applied.length },
      "migration plan completed",
    );
    return plan;
  }

  async up(options: MigrationRunOptions = {}): Promise<MigrationResult> {
    const startedAt = performance.now();
    const dryRun = options.dryRun ?? false;
    const steps = normalizeOptionalSteps(options.steps);
    const plan = await this.plan();

    this.#assertCleanPlan(plan, options.allowDirty);

    const migrations = steps === undefined
      ? plan.pending.map((item) => item.migration)
      : plan.pending.slice(0, steps).map((item) => item.migration);

    if (dryRun) {
      for (const migration of migrations) {
        this.#info(
          "migrate.step",
          { id: migration.id, direction: "up" },
          "migration dry run",
        );
      }

      return {
        direction: "up",
        dryRun,
        executed: [],
        skipped: migrations.map((migration) => migration.id),
        executionMs: elapsedMs(startedAt),
      };
    }

    const executed: AppliedMigration[] = [];
    let lockAcquired = false;

    try {
      lockAcquired = await this.#acquireLock();

      for (const migration of migrations) {
        const applied = await this.#runUpMigration(migration);
        executed.push(applied);
      }
    } catch (error) {
      const failedId = getErrorMigrationId(error);
      throw toMigrationError(error, "MIGRATION_EXECUTE_FAILED", {
        id: failedId,
        direction: "up",
      });
    } finally {
      if (lockAcquired) {
        await this.#releaseLock();
      }
    }

    return {
      direction: "up",
      dryRun,
      executed,
      skipped: [],
      executionMs: elapsedMs(startedAt),
    };
  }

  async down(options: MigrationDownOptions = {}): Promise<MigrationResult> {
    const startedAt = performance.now();
    const dryRun = options.dryRun ?? false;
    const applied = await this.#store.listApplied();
    const steps = normalizeOptionalSteps(options.steps);
    const migrations = selectRollbackMigrations(
      this.#migrations,
      applied,
      steps,
      options.to,
    );
    const plan = createMigrationPlan(this.#migrations, applied);

    this.#assertCleanPlan(plan, options.allowDirty);
    assertRollbackSteps(migrations);

    if (dryRun) {
      for (const migration of migrations) {
        this.#info(
          "migrate.step",
          { id: migration.id, direction: "down" },
          "migration dry run",
        );
      }

      return {
        direction: "down",
        dryRun,
        executed: [],
        skipped: migrations.map((migration) => migration.id),
        executionMs: elapsedMs(startedAt),
      };
    }

    const executed: AppliedMigration[] = [];
    let lockAcquired = false;

    try {
      lockAcquired = await this.#acquireLock();

      for (const migration of migrations) {
        const rolledBack = await this.#runDownMigration(migration);
        executed.push(rolledBack);
      }
    } catch (error) {
      const failedId = getErrorMigrationId(error);
      throw toMigrationError(error, "MIGRATION_ROLLBACK_FAILED", {
        id: failedId,
        direction: "down",
      });
    } finally {
      if (lockAcquired) {
        await this.#releaseLock();
      }
    }

    return {
      direction: "down",
      dryRun,
      executed,
      skipped: [],
      executionMs: elapsedMs(startedAt),
    };
  }

  async pending(): Promise<Migration[]> {
    const applied = await this.#store.listApplied();
    return getPendingMigrations(this.#migrations, applied);
  }

  async applied(): Promise<AppliedMigration[]> {
    return await this.#store.listApplied();
  }

  async close(): Promise<void> {
    await this.#store.close?.();
    await this.#driver.close?.();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  async #runUpMigration(migration: Migration): Promise<AppliedMigration> {
    this.#info(
      "migrate.step",
      { id: migration.id, direction: "up" },
      "migration started",
    );
    const startedAt = performance.now();

    try {
      const applied = await this.#runInTransaction(async (scope) => {
        await executeMigrationStep(this.#resolveStep(migration.up), {
          driver: scope.driver,
          logger: this.#log.settings.logger,
          logging: this.#loggingSettings(),
          log: this.#log,
          dryRun: false,
          direction: "up",
        });

        const applied = createAppliedMigration(migration, {
          executionMs: elapsedMs(startedAt),
        });

        try {
          await scope.store.markApplied(applied);
          if (this.#log.settings.metadata) {
            this.#debug(
              "migrate.history",
              { id: migration.id, direction: "up" },
              "migration history marked",
            );
          }
        } catch (error) {
          if (this.#log.settings.metadata) {
            this.#error(
              "migrate.history",
              { id: migration.id, direction: "up" },
              "migration history mark failed",
            );
          }
          throw new MigrationError("Failed to mark migration as applied", {
            code: "MIGRATION_MARK_APPLIED_FAILED",
            details: { id: migration.id },
            cause: error,
          });
        }

        return applied;
      });

      this.#info(
        "migrate.step",
        { id: migration.id, direction: "up", executionMs: applied.executionMs },
        "migration completed",
      );
      return applied;
    } catch (error) {
      this.#error(
        "migrate.step",
        { id: migration.id, direction: "up" },
        "migration failed",
      );
      throw toMigrationError(error, "MIGRATION_EXECUTE_FAILED", {
        id: migration.id,
        direction: "up",
      });
    }
  }

  async #runDownMigration(migration: Migration): Promise<AppliedMigration> {
    if (migration.down === undefined) {
      throw new MigrationError("Migration does not define a down step", {
        code: "MIGRATION_ROLLBACK_FAILED",
        details: { id: migration.id, direction: "down" },
      });
    }

    this.#info(
      "migrate.step",
      { id: migration.id, direction: "down" },
      "migration started",
    );
    const startedAt = performance.now();

    try {
      const rolledBack = await this.#runInTransaction(async (scope) => {
        await executeMigrationStep(this.#resolveStep(migration.down!), {
          driver: scope.driver,
          logger: this.#log.settings.logger,
          logging: this.#loggingSettings(),
          log: this.#log,
          dryRun: false,
          direction: "down",
        });

        try {
          await scope.store.unmarkApplied(migration.id);
          if (this.#log.settings.metadata) {
            this.#debug(
              "migrate.history",
              { id: migration.id, direction: "down" },
              "migration history unmarked",
            );
          }
        } catch (error) {
          if (this.#log.settings.metadata) {
            this.#error(
              "migrate.history",
              { id: migration.id, direction: "down" },
              "migration history unmark failed",
            );
          }
          throw new MigrationError(
            "Failed to remove applied migration record",
            {
              code: "MIGRATION_UNMARK_APPLIED_FAILED",
              details: { id: migration.id },
              cause: error,
            },
          );
        }

        return createAppliedMigration(migration, {
          appliedAt: new Date(),
          executionMs: elapsedMs(startedAt),
        });
      });

      this.#info(
        "migrate.step",
        {
          id: migration.id,
          direction: "down",
          executionMs: rolledBack.executionMs,
        },
        "migration completed",
      );
      return rolledBack;
    } catch (error) {
      this.#error(
        "migrate.step",
        { id: migration.id, direction: "down" },
        "migration failed",
      );
      throw toMigrationError(error, "MIGRATION_ROLLBACK_FAILED", {
        id: migration.id,
        direction: "down",
      });
    }
  }

  async #runInTransaction<T>(
    fn: (
      scope: {
        readonly driver: MigrationDriver;
        readonly store: MigrationStore;
      },
    ) => Promise<T>,
  ): Promise<T> {
    if (this.#useTransaction && this.#driver.transaction !== undefined) {
      return await this.#driver.transaction((tx) =>
        fn({
          driver: tx.driver,
          store: tx.store ?? this.#store,
        })
      );
    }

    return await fn({ driver: this.#driver, store: this.#store });
  }

  #assertCleanPlan(plan: MigrationPlan, allowDirty: boolean | undefined): void {
    if (!plan.hasChecksumMismatches || allowDirty === true) {
      return;
    }

    const mismatch = plan.checksumMismatches[0];

    if (mismatch?.applied !== undefined) {
      assertMigrationChecksum(mismatch.applied, mismatch.migration);
    }
  }

  async #acquireLock(): Promise<boolean> {
    if (this.#store.acquireLock === undefined) {
      this.#warn(
        "migrate.lock",
        { lockId: this.#lockId },
        "migration store has no lock",
      );
      return false;
    }

    const acquired = await this.#store.acquireLock(this.#lockId);

    if (!acquired) {
      throw new MigrationError("Failed to acquire migration lock", {
        code: "MIGRATION_LOCK_FAILED",
        details: { lockId: this.#lockId },
      });
    }

    this.#debug(
      "migrate.lock",
      { lockId: this.#lockId },
      "migration lock acquired",
    );
    return true;
  }

  async #releaseLock(): Promise<void> {
    if (this.#store.releaseLock === undefined) {
      return;
    }

    try {
      await this.#store.releaseLock(this.#lockId);
      this.#debug(
        "migrate.lock",
        { lockId: this.#lockId },
        "migration lock released",
      );
    } catch (error) {
      throw new MigrationError("Failed to release migration lock", {
        code: "MIGRATION_UNLOCK_FAILED",
        details: { lockId: this.#lockId },
        cause: error,
      });
    }
  }

  #loggingSettings(): SisalLogSettings {
    return {
      level: this.#log.settings.level,
      categories: this.#log.settings.categories,
      sql: this.#log.settings.sql,
    };
  }

  #debug(
    category: SisalLogCategory,
    record: Record<string, unknown> | undefined,
    message: string,
  ): void {
    this.#log.emit({ level: "debug", category, record, message });
  }

  #info(
    category: SisalLogCategory,
    record: Record<string, unknown>,
    message: string,
  ): void {
    this.#log.emit({ level: "info", category, record, message });
  }

  #warn(
    category: SisalLogCategory,
    record: Record<string, unknown>,
    message: string,
  ): void {
    this.#log.emit({ level: "warn", category, record, message });
  }

  #error(
    category: SisalLogCategory,
    record: Record<string, unknown>,
    message: string,
  ): void {
    this.#log.emit({ level: "error", category, record, message });
  }
}

interface MigrationExecutionContext extends MigrationContext {
  readonly log: SisalLogEmitter;
}

async function executeMigrationStep(
  step: MigrationStep,
  context: MigrationExecutionContext,
): Promise<void> {
  if (context.dryRun) {
    return;
  }

  if (typeof step === "string") {
    if (
      context.log.settings.metadata &&
      context.log.enabled("debug", "migrate.sql")
    ) {
      context.log.emit({
        level: "debug",
        category: "migrate.sql",
        record: { direction: context.direction, sql: step },
        message: "migration sql executed",
      });
    }
    await context.driver.execute(step);
    return;
  }

  if (isSqlStepArray(step)) {
    for (const [index, sql] of step.entries()) {
      if (
        context.log.settings.metadata &&
        context.log.enabled("debug", "migrate.sql")
      ) {
        context.log.emit({
          level: "debug",
          category: "migrate.sql",
          record: {
            direction: context.direction,
            statement: index + 1,
            statements: step.length,
            sql,
          },
          message: "migration sql executed",
        });
      }
      await context.driver.execute(sql);
    }

    return;
  }

  await step(context);
}

function selectRollbackMigrations(
  migrations: Migration[],
  applied: AppliedMigration[],
  steps: number | undefined,
  to: MigrationId | undefined,
): Migration[] {
  let rollbackMigrations = getRollbackMigrations(migrations, applied, steps);

  if (to !== undefined) {
    const targetId = normalizeMigrationId(to);
    const targetIndex = rollbackMigrations.findIndex((migration) =>
      migration.id === targetId
    );

    if (targetIndex < 0) {
      throw new MigrationError("Rollback target migration is not applied", {
        code: "MIGRATION_INVALID",
        details: { id: targetId },
      });
    }

    rollbackMigrations = rollbackMigrations.slice(0, targetIndex + 1);
  }

  return rollbackMigrations;
}

function assertRollbackSteps(migrations: Migration[]): void {
  for (const migration of migrations) {
    if (migration.down === undefined) {
      throw new MigrationError("Migration does not define a down step", {
        code: "MIGRATION_ROLLBACK_FAILED",
        details: { id: migration.id, direction: "down" },
      });
    }
  }
}

function getMigrationChecksum(migration: Migration): MigrationChecksum {
  return migration.checksum ?? calculateMigrationChecksum(migration);
}

function normalizeMigrationId(id: MigrationId): MigrationId {
  if (typeof id !== "string") {
    throwInvalidMigration("Migration id must be a string");
  }

  const normalized = id.trim();

  if (normalized.length === 0) {
    throwInvalidMigration("Migration id cannot be empty");
  }

  if (!/^[A-Za-z0-9_.-]+$/.test(normalized)) {
    throwInvalidMigration(
      "Migration id can only contain letters, numbers, underscore, hyphen, and dot",
      { id: normalized },
    );
  }

  return normalized;
}

function normalizeChecksum(checksum: MigrationChecksum): MigrationChecksum {
  if (typeof checksum !== "string" || checksum.trim().length === 0) {
    throwInvalidMigration("Migration checksum must be a non-empty string");
  }

  return checksum.trim();
}

function validateMigrationStep(
  step: MigrationStep,
  field: string,
  id: MigrationId,
): void {
  if (typeof step === "function") {
    return;
  }

  if (typeof step === "string") {
    assertNonEmptyString(step, field, id);
    return;
  }

  if (isSqlStepArray(step)) {
    if (step.length === 0) {
      throwInvalidMigration("Migration SQL step array cannot be empty", {
        id,
        field,
      });
    }

    for (const sql of step) {
      assertNonEmptyString(sql, field, id);
    }

    return;
  }

  throwInvalidMigration("Migration step must be SQL or a function", {
    id,
    field,
  });
}

function assertNonEmptyString(
  value: string,
  field: string,
  id: MigrationId,
): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throwInvalidMigration(`Migration ${field} must be a non-empty string`, {
      id,
      field,
    });
  }
}

function migrationStepToString(step: MigrationStep): string {
  return isSqlStepArray(step)
    ? step.join("\n")
    : typeof step === "string"
    ? step
    : step.toString();
}

function isSqlStepArray(step: MigrationStep): step is readonly string[] {
  return Array.isArray(step);
}

function cloneAppliedMigration(
  migration: AppliedMigration,
  useStructuredClone: boolean,
): AppliedMigration {
  if (useStructuredClone) {
    try {
      if (typeof globalThis.structuredClone === "function") {
        return globalThis.structuredClone(migration);
      }
    } catch {
      // Fall through to a safe shallow clone.
    }
  }

  return {
    id: normalizeMigrationId(migration.id),
    checksum: normalizeChecksum(migration.checksum),
    appliedAt: toIsoString(migration.appliedAt, "appliedAt"),
    ...(migration.executionMs === undefined ? {} : {
      executionMs: normalizeNonNegativeNumber(
        migration.executionMs,
        "executionMs",
      ),
    }),
    ...(migration.description === undefined
      ? {}
      : { description: migration.description }),
  };
}

function normalizeOptionalSteps(steps: number | undefined): number | undefined {
  if (steps === undefined) {
    return undefined;
  }

  if (!Number.isInteger(steps) || steps <= 0) {
    throw new MigrationError("Migration steps must be a positive integer", {
      code: "MIGRATION_INVALID",
      details: { option: "steps" },
    });
  }

  return steps;
}

function normalizeNonNegativeNumber(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new MigrationError(`${field} must be zero or greater`, {
      code: "MIGRATION_INVALID",
      details: { field },
    });
  }

  return value;
}

function toIsoString(value: Date | string | number, field: string): string {
  const date = value instanceof Date
    ? new Date(value.getTime())
    : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new MigrationError("Migration timestamp is invalid", {
      code: "MIGRATION_INVALID",
      details: { field },
    });
  }

  return date.toISOString();
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt);
}

function hashString(input: string): string {
  let hash = 2166136261;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function throwInvalidMigration(
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new MigrationError(message, {
    code: "MIGRATION_INVALID",
    details,
  });
}

function getErrorMigrationId(error: unknown): MigrationId | undefined {
  if (error instanceof MigrationError) {
    const id = error.details?.id;
    return typeof id === "string" ? id : undefined;
  }

  return undefined;
}

function toMigrationError(
  error: unknown,
  code: MigrationErrorCode,
  details: Record<string, unknown>,
): MigrationError {
  if (error instanceof MigrationError) {
    return error;
  }

  return new MigrationError("Migration operation failed", {
    code,
    details,
    cause: error,
  });
}

// Examples:
//
// const createUsers = defineSqlMigration({
//   id: "001_create_users",
//   up: `
//     create table users (
//       id text primary key,
//       name text not null
//     );
//   `,
//   down: `
//     drop table users;
//   `,
// });
//
// const migrator = createMigrator({
//   migrations: [createUsers],
//   store: memoryMigrationStore(),
//   driver,
// });
//
// const plan = await migrator.plan();
// await migrator.up({ dryRun: true });
// await migrator.up();
// await migrator.down({ steps: 1 });
//
// const programmatic = defineMigration({
//   id: "002_programmatic",
//   up: async (ctx) => {
//     await ctx.driver.execute("select 1");
//   },
// });
//
// const disabledMigrator = noopMigrator();
