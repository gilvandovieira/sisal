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

/** Default PostgreSQL table used to store applied migration history. */
export const DEFAULT_PG_MIGRATION_TABLE = "sisal_migrations";

const DEFAULT_PG_MIGRATION_LOCK_ID = "sisal:migrate";
const FNV_64_OFFSET = 0xcbf29ce484222325n;
const FNV_64_PRIME = 0x100000001b3n;
const textEncoder = new TextEncoder();

/** Options for creating a PostgreSQL-backed migration history store. */
export interface PgMigrationHistoryStoreOptions {
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

interface AdvisoryLockRow {
  readonly acquired?: unknown;
  readonly released?: unknown;
}

/** Creates a migration history store persisted in a PostgreSQL table. */
export function createPgMigrationHistoryStore(
  options: PgMigrationHistoryStoreOptions,
): MigrationStore {
  const executor = options.executor;
  const tableName = quoteIdentifierPath(
    options.tableName ?? DEFAULT_PG_MIGRATION_TABLE,
  );
  let ensured = false;

  async function ensureHistoryTable(): Promise<void> {
    if (ensured) {
      return;
    }

    await executor.execute(`
      create table if not exists ${tableName} (
        id text primary key,
        checksum text not null,
        description text,
        applied_at timestamptz not null,
        execution_ms double precision
      )
    `);
    ensured = true;
  }

  let lockSession: SqlExecutorSession | undefined;
  let lockKey: string | undefined;

  async function acquireLock(lockId?: string): Promise<boolean> {
    if (lockSession !== undefined) {
      return false;
    }

    const acquireSession = executor.acquireSession?.bind(executor);

    if (acquireSession === undefined) {
      return false;
    }

    const key = advisoryLockKey(lockId);
    const session = await acquireSession();
    let released = false;

    try {
      const result = await session.execute<AdvisoryLockRow>(
        `
          select pg_try_advisory_lock($1::bigint) as "acquired"
        `,
        [key],
      );
      const acquired = assertBoolean(result.rows[0]?.acquired, "acquired");

      if (!acquired) {
        await session.release();
        released = true;
        return false;
      }

      lockSession = session;
      lockKey = key;
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
    const key = lockKey;

    if (session === undefined || key === undefined) {
      return;
    }

    try {
      const result = await session.execute<AdvisoryLockRow>(
        `
          select pg_advisory_unlock($1::bigint) as "released"
        `,
        [key],
      );
      const released = assertBoolean(result.rows[0]?.released, "released");

      if (!released) {
        throw new MigrationError("PostgreSQL migration lock was not held", {
          code: "MIGRATION_UNLOCK_FAILED",
          details: { lockKey: key },
        });
      }
    } finally {
      lockSession = undefined;
      lockKey = undefined;
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
          applied_at as "appliedAt",
          execution_ms as "executionMs"
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
            applied_at as "appliedAt",
            execution_ms as "executionMs"
          from ${tableName}
          where id = $1
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
          ) values ($1, $2, $3, $4, $5)
        `,
        [
          migration.id,
          migration.checksum,
          migration.description ?? null,
          migration.appliedAt,
          migration.executionMs ?? null,
        ],
      );
    },

    async unmarkApplied(id: MigrationId): Promise<boolean> {
      await ensureHistoryTable();
      const result: QueryResult = await executor.execute(
        `delete from ${tableName} where id = $1`,
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
    throw new MigrationError("PostgreSQL history table name is required", {
      code: "MIGRATION_INVALID",
      status: 400,
    });
  }

  return path.trim().split(".").map(quoteIdentifier).join(".");
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new MigrationError("PostgreSQL identifier is invalid", {
      code: "MIGRATION_INVALID",
      status: 400,
      details: { identifier },
    });
  }

  return `"${identifier}"`;
}

function advisoryLockKey(lockId?: string): string {
  const normalized = lockId ?? DEFAULT_PG_MIGRATION_LOCK_ID;

  if (typeof normalized !== "string" || normalized.trim().length === 0) {
    throw new MigrationError("PostgreSQL migration lock id is required", {
      code: "MIGRATION_INVALID",
      status: 400,
    });
  }

  let hash = FNV_64_OFFSET;

  for (const byte of textEncoder.encode(normalized.trim())) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * FNV_64_PRIME);
  }

  return BigInt.asIntN(64, hash).toString();
}

function assertBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new MigrationError("PostgreSQL migration lock row is invalid", {
      code: "MIGRATION_INVALID",
      details: { field },
    });
  }

  return value;
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
  // PostgreSQL `double precision`/`numeric` columns are returned as strings by
  // some drivers (e.g. `@db/postgres` returns `float8` as a string), so coerce a
  // numeric string before validating.
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
