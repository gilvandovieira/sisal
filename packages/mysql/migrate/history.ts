/**
 * MySQL/MariaDB-backed migration history store for `@sisal/migrate`.
 *
 * The applied-migration ledger lives in a MySQL table (default
 * `sisal_migrations`), and concurrent migrators are excluded with
 * `GET_LOCK`/`RELEASE_LOCK` **named locks** — the `pg_advisory_lock`
 * analogue recorded in the v0.6 C4 report. Named locks are
 * connection-scoped, so the store holds them on a pinned executor session
 * (the lock dies with the connection, which is exactly the crash-safety
 * property advisory locking wants).
 *
 * @module
 */

import type {
  AppliedMigration,
  MigrationId,
  MigrationStore,
} from "@sisal/migrate";
import { MigrationError } from "@sisal/migrate";

import type {
  QueryResult,
  SqlExecutor,
  SqlExecutorSession,
} from "./executor.ts";

/** Default MySQL table used to store applied migration history. */
export const DEFAULT_MYSQL_MIGRATION_TABLE = "sisal_migrations";

const DEFAULT_MYSQL_MIGRATION_LOCK_ID = "sisal:migrate";

// MySQL enforces a 64-character maximum on GET_LOCK names.
const MYSQL_LOCK_NAME_MAX_LENGTH = 64;

/** Options for creating a MySQL-backed migration history store. */
export interface MysqlMigrationHistoryStoreOptions {
  readonly executor: SqlExecutor;
  readonly tableName?: string;
}

interface AppliedMigrationRow {
  readonly id?: unknown;
  readonly checksum?: unknown;
  readonly description?: unknown;
  readonly appliedAt?: unknown;
  readonly applied_at?: unknown;
  readonly executionMs?: unknown;
  readonly execution_ms?: unknown;
}

interface NamedLockRow {
  readonly acquired?: unknown;
  readonly released?: unknown;
}

/** Creates a migration history store persisted in a MySQL table. */
export function createMysqlMigrationHistoryStore(
  options: MysqlMigrationHistoryStoreOptions,
): MigrationStore {
  const executor = options.executor;
  const tableName = quoteIdentifierPath(
    options.tableName ?? DEFAULT_MYSQL_MIGRATION_TABLE,
  );
  let ensured = false;

  // The ledger obeys the adapter's own B5 DDL rules: a VARCHAR key (TEXT
  // cannot be a MySQL primary key) and DATETIME(6) (no timezone conversion,
  // no 2038 range cliff).
  async function ensureHistoryTable(): Promise<void> {
    if (ensured) {
      return;
    }

    await executor.execute(`
      create table if not exists ${tableName} (
        id varchar(255) primary key,
        checksum varchar(255) not null,
        description text,
        applied_at datetime(6) not null,
        execution_ms double
      )
    `);
    ensured = true;
  }

  let lockSession: SqlExecutorSession | undefined;
  let lockName: string | undefined;

  async function acquireLock(lockId?: string): Promise<boolean> {
    if (lockSession !== undefined) {
      return false;
    }

    const acquireSession = executor.acquireSession?.bind(executor);

    if (acquireSession === undefined) {
      return false;
    }

    // Validate an explicit lock id up front, before opening a connection.
    const explicitName = lockId === undefined
      ? undefined
      : namedLockName(lockId);
    const session = await acquireSession();
    let released = false;

    try {
      // The default lock id is namespaced by the current database, so unrelated
      // Sisal projects on a shared server do not serialize on one server-global
      // name (SEC-013). An explicit id is used verbatim.
      const name = explicitName ?? await defaultLockName(session);
      // Timeout 0 = try-lock (the pg_try_advisory_lock parity).
      const result = await session.execute<NamedLockRow>(
        "select get_lock(?, 0) as `acquired`",
        [name],
      );
      const acquired = toLockResult(result.rows[0]?.acquired, "acquired");

      if (acquired !== 1) {
        await session.release();
        released = true;
        return false;
      }

      lockSession = session;
      lockName = name;
      return true;
    } catch (error) {
      if (!released) {
        await session.release();
      }

      throw error;
    }
  }

  async function releaseLock(): Promise<void> {
    const session = lockSession;
    const name = lockName;

    if (session === undefined || name === undefined) {
      return;
    }

    try {
      const result = await session.execute<NamedLockRow>(
        "select release_lock(?) as `released`",
        [name],
      );
      const released = toLockResult(result.rows[0]?.released, "released");

      if (released !== 1) {
        throw new MigrationError("MySQL migration lock was not held", {
          code: "MIGRATION_UNLOCK_FAILED",
          details: { lockName: name },
        });
      }
    } finally {
      lockSession = undefined;
      lockName = undefined;
      await session.release();
    }
  }

  const store: MigrationStore = {
    async listApplied(): Promise<AppliedMigration[]> {
      await ensureHistoryTable();
      const result = await executor.execute<AppliedMigrationRow>(`
        select
          id,
          checksum,
          description,
          applied_at as \`appliedAt\`,
          execution_ms as \`executionMs\`
        from ${tableName}
        order by id asc
      `);

      return result.rows.map(rowToAppliedMigration);
    },

    async getApplied(
      id: MigrationId,
    ): Promise<AppliedMigration | undefined> {
      await ensureHistoryTable();
      const result = await executor.execute<AppliedMigrationRow>(
        `
          select
            id,
            checksum,
            description,
            applied_at as \`appliedAt\`,
            execution_ms as \`executionMs\`
          from ${tableName}
          where id = ?
          limit 1
        `,
        [id],
      );

      const row = result.rows[0];
      return row === undefined ? undefined : rowToAppliedMigration(row);
    },

    async markApplied(migration: AppliedMigration): Promise<void> {
      await ensureHistoryTable();
      await executor.execute(
        `
          insert into ${tableName} (
            id,
            checksum,
            description,
            applied_at,
            execution_ms
          ) values (?, ?, ?, ?, ?)
        `,
        [
          migration.id,
          migration.checksum,
          migration.description ?? null,
          // A Date param round-trips through both drivers' connection
          // timezone symmetrically; an ISO string with a trailing "Z" is
          // rejected by MySQL DATETIME.
          toAppliedAtDate(migration.appliedAt),
          migration.executionMs ?? null,
        ],
      );
    },

    async unmarkApplied(id: MigrationId): Promise<boolean> {
      await ensureHistoryTable();
      const result: QueryResult = await executor.execute(
        `delete from ${tableName} where id = ?`,
        [id],
      );

      return result.rowCount > 0;
    },

    async close(): Promise<void> {
      try {
        await releaseLock();
      } finally {
        await executor.close?.();
      }
    },
  };

  if (executor.acquireSession === undefined) {
    return store;
  }

  return {
    ...store,
    acquireLock,
    releaseLock,
  };
}

function rowToAppliedMigration(row: AppliedMigrationRow): AppliedMigration {
  const id = assertString(row.id, "id");
  const checksum = assertString(row.checksum, "checksum");
  const appliedAt = toIsoString(row.appliedAt ?? row.applied_at, "appliedAt");
  const executionMs = row.executionMs ?? row.execution_ms;
  const description = row.description;

  return {
    id,
    checksum,
    appliedAt,
    ...(executionMs === null || executionMs === undefined
      ? {}
      : { executionMs: assertNumber(executionMs, "executionMs") }),
    ...(description === null || description === undefined
      ? {}
      : { description: assertString(description, "description") }),
  };
}

function quoteIdentifierPath(path: string): string {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new MigrationError("MySQL history table name is required", {
      code: "MIGRATION_INVALID",
      status: 400,
    });
  }

  return path.trim().split(".").map(quoteIdentifier).join(".");
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new MigrationError("MySQL identifier is invalid", {
      code: "MIGRATION_INVALID",
      status: 400,
      details: { identifier },
    });
  }

  return `\`${identifier}\``;
}

// GET_LOCK names are server-wide strings with a 64-character maximum; the
// lock id is used verbatim (no hashing — unlike pg's bigint advisory keys).
function namedLockName(lockId?: string): string {
  const normalized = (lockId ?? DEFAULT_MYSQL_MIGRATION_LOCK_ID).trim();

  if (normalized.length === 0) {
    throw new MigrationError("MySQL migration lock id is required", {
      code: "MIGRATION_INVALID",
      status: 400,
    });
  }

  if (normalized.length > MYSQL_LOCK_NAME_MAX_LENGTH) {
    throw new MigrationError("MySQL migration lock id is too long", {
      code: "MIGRATION_INVALID",
      status: 400,
      details: { lockId: normalized, maxLength: MYSQL_LOCK_NAME_MAX_LENGTH },
    });
  }

  return normalized;
}

// Namespaces the default migration lock name by the current database, so two
// Sisal projects sharing a MySQL server do not contend on one server-global
// `GET_LOCK` name (SEC-013). Falls back to the bare id when there is no current
// database, and to a hashed suffix when the database name would push the
// composed name past MySQL's 64-character `GET_LOCK` limit.
async function defaultLockName(session: SqlExecutorSession): Promise<string> {
  const result = await session.execute<{ db?: unknown }>(
    "select database() as `db`",
  );
  const raw = result.rows[0]?.db;
  const database = typeof raw === "string" ? raw.trim() : "";
  if (database.length === 0) {
    return DEFAULT_MYSQL_MIGRATION_LOCK_ID;
  }
  const composed = `${DEFAULT_MYSQL_MIGRATION_LOCK_ID}:${database}`;
  if (composed.length <= MYSQL_LOCK_NAME_MAX_LENGTH) {
    return composed;
  }
  return `${DEFAULT_MYSQL_MIGRATION_LOCK_ID}:${fnv1aHex(database)}`;
}

// FNV-1a 32-bit → 8 hex chars. A stable, dependency-free hash used only to keep
// a very long database name's lock namespace within the 64-char ceiling.
function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// GET_LOCK/RELEASE_LOCK return BIGINT 1/0 or NULL — and the mandated
// bigint-as-string driver options decode that as the *string* "1"/"0".
function toLockResult(value: unknown, field: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number" && (value === 0 || value === 1)) {
    return value;
  }
  if (typeof value === "bigint" && (value === 0n || value === 1n)) {
    return Number(value);
  }
  if (typeof value === "string" && (value === "0" || value === "1")) {
    return Number(value);
  }

  throw new MigrationError("MySQL migration lock row is invalid", {
    code: "MIGRATION_INVALID",
    details: { field },
  });
}

function toAppliedAtDate(value: string): Date {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new MigrationError("Migration history timestamp is invalid", {
      code: "MIGRATION_INVALID",
      details: { field: "appliedAt" },
    });
  }

  return date;
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new MigrationError("Migration history row is invalid", {
      code: "MIGRATION_INVALID",
      details: { field },
    });
  }

  return value;
}

function assertNumber(value: unknown, field: string): number {
  // DOUBLE round-trips as a number on mysql2, but keep the string coercion
  // pg needed — the mariadb connector's DECIMAL-as-string setting can leak
  // into computed columns.
  const numeric = typeof value === "string" ? Number(value) : value;

  if (typeof numeric !== "number" || !Number.isFinite(numeric)) {
    throw new MigrationError("Migration history row is invalid", {
      code: "MIGRATION_INVALID",
      details: { field },
    });
  }

  return numeric;
}

function toIsoString(value: unknown, field: string): string {
  // Drivers return DATETIME as a Date (or occasionally a bare local-time
  // string); both drivers write Date params as local wall-clock, so a bare
  // string parses as local too — the round trip stays symmetric.
  if (typeof value === "string") {
    const date = new Date(value);

    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }

  throw new MigrationError("Migration history timestamp is invalid", {
    code: "MIGRATION_INVALID",
    details: { field },
  });
}
