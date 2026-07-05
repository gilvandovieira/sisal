import { assertEquals } from "@std/assert";

import {
  createLibsqlMigrationHistoryStore,
  DEFAULT_LIBSQL_MIGRATION_TABLE,
} from "../../src/migrate/history.ts";
import type { QueryResult, SqlExecutor } from "../../src/migrate/executor.ts";

Deno.test("@sisal/libsql - migration history store persists rows", async () => {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const executor: SqlExecutor = {
    execute<Row = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<Row>> {
      calls.push({ sql, params });
      if (sql.includes("select") && sql.includes("order by")) {
        return Promise.resolve({
          rows: [{
            id: "0001_init",
            checksum: "abc",
            appliedAt: "2024-01-01T00:00:00.000Z",
            executionMs: "4.5",
          }] as Row[],
          rowCount: 1,
        });
      }

      return Promise.resolve({ rows: [], rowCount: 1 });
    },
  };
  const store = createLibsqlMigrationHistoryStore({ executor });

  await store.markApplied({
    id: "0001_init",
    checksum: "abc",
    appliedAt: "2024-01-01T00:00:00.000Z",
    executionMs: 4.5,
  });
  const applied = await store.listApplied();

  assertEquals(applied, [{
    id: "0001_init",
    checksum: "abc",
    appliedAt: "2024-01-01T00:00:00.000Z",
    executionMs: 4.5,
  }]);
  assertEquals(DEFAULT_LIBSQL_MIGRATION_TABLE, "sisal_migrations");
  assertEquals(calls.some((call) => call.sql.includes("create table")), true);
  assertEquals(calls.some((call) => call.sql.includes("insert into")), true);
});
