import type {
  AppliedMigration,
  MigrationId,
  MigrationStore,
} from "@sisal/migrate";
import { MigrationError } from "@sisal/migrate";

import type { QueryResult, SqlExecutor } from "./executor.ts";

/** Default PostgreSQL table used to store applied migration history. */
export const DEFAULT_PG_MIGRATION_TABLE = "sisal_migrations";

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

  return {
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
      await executor.close?.();
    },
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
