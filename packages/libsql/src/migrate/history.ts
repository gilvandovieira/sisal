import type {
  AppliedMigration,
  MigrationId,
  MigrationStore,
} from "@sisal/migrate";
import { MigrationError } from "@sisal/migrate";

import type { QueryResult, SqlExecutor } from "./executor.ts";

/** Default libSQL table used to store applied migration history. */
export const DEFAULT_LIBSQL_MIGRATION_TABLE = "sisal_migrations";

/** Options for creating a libSQL-backed migration history store. */
export interface LibsqlMigrationHistoryStoreOptions {
  /** History table name used by this libsql migration history store options. */
  readonly executor: SqlExecutor;
  /** History table name used by this libsql migration history store options. */
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

/** Creates a migration history store persisted in a libSQL table. */
export function createLibsqlMigrationHistoryStore(
  options: LibsqlMigrationHistoryStoreOptions,
): MigrationStore {
  const executor = options.executor;
  const tableName = quoteIdentifier(
    options.tableName ?? DEFAULT_LIBSQL_MIGRATION_TABLE,
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
        applied_at text not null,
        execution_ms real
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
          applied_at as appliedAt,
          execution_ms as executionMs
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
            applied_at as appliedAt,
            execution_ms as executionMs
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
          migration.appliedAt,
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

function quoteIdentifier(path: string): string {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new MigrationError("libSQL history table name is required", {
      code: "MIGRATION_INVALID",
      status: 400,
    });
  }

  return path.trim().split(".").map((identifier) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
      throw new MigrationError("libSQL identifier is invalid", {
        code: "MIGRATION_INVALID",
        status: 400,
        details: { identifier },
      });
    }

    return `"${identifier}"`;
  }).join(".");
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
