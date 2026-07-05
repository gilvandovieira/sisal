import { assert, assertEquals, assertRejects } from "@std/assert";

import {
  createPgExecutor,
  type QueryResult,
  type SqlExecutor,
  type SqlExecutorSession,
} from "../../src/migrate/executor.ts";
import {
  createPgMigrationHistoryStore,
  DEFAULT_PG_MIGRATION_TABLE,
} from "../../src/migrate/history.ts";
import type {
  PgClient,
  PgDriverResult,
  PgPool,
} from "../../src/migrate/pool.ts";

interface QueryCall {
  readonly sql: string;
  readonly params: readonly unknown[];
}

Deno.test("@sisal/pg - migration history store omits locks without pinned sessions", () => {
  const executor: SqlExecutor = {
    execute<Row = Record<string, unknown>>(): Promise<QueryResult<Row>> {
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
  const store = createPgMigrationHistoryStore({ executor });

  assertEquals(store.acquireLock, undefined);
  assertEquals(store.releaseLock, undefined);
  assertEquals(DEFAULT_PG_MIGRATION_TABLE, "sisal_migrations");
});

Deno.test("@sisal/pg - migration history store uses advisory locks", async () => {
  const calls: QueryCall[] = [];
  let releases = 0;
  const session: SqlExecutorSession = {
    execute<Row = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<Row>> {
      calls.push({ sql, params });

      if (sql.includes("pg_try_advisory_lock")) {
        return Promise.resolve({
          rows: [{ acquired: true }] as Row[],
          rowCount: 1,
        });
      }

      if (sql.includes("pg_advisory_unlock")) {
        return Promise.resolve({
          rows: [{ released: true }] as Row[],
          rowCount: 1,
        });
      }

      return Promise.resolve({ rows: [], rowCount: 0 });
    },

    release(): Promise<void> {
      releases += 1;
      return Promise.resolve();
    },
  };
  const executor: SqlExecutor = {
    execute<Row = Record<string, unknown>>(): Promise<QueryResult<Row>> {
      return Promise.resolve({ rows: [], rowCount: 0 });
    },

    acquireSession(): Promise<SqlExecutorSession> {
      return Promise.resolve(session);
    },
  };
  const store = createPgMigrationHistoryStore({ executor });

  assert(store.acquireLock !== undefined);
  assert(store.releaseLock !== undefined);
  assertEquals(await store.acquireLock("tenant-a"), true);
  assertEquals(await store.acquireLock("tenant-a"), false);
  await store.releaseLock("tenant-a");

  assertEquals(releases, 1);
  assertEquals(calls.length, 2);
  assert(calls[0].sql.includes("pg_try_advisory_lock"));
  assert(calls[1].sql.includes("pg_advisory_unlock"));
  assertEquals(typeof calls[0].params[0], "string");
  assertEquals(calls[1].params[0], calls[0].params[0]);
  BigInt(calls[0].params[0] as string);
});

Deno.test("@sisal/pg - migration history store releases busy lock sessions", async () => {
  let releases = 0;
  const executor: SqlExecutor = {
    execute<Row = Record<string, unknown>>(): Promise<QueryResult<Row>> {
      return Promise.resolve({ rows: [], rowCount: 0 });
    },

    acquireSession(): Promise<SqlExecutorSession> {
      return Promise.resolve({
        execute<Row = Record<string, unknown>>(): Promise<QueryResult<Row>> {
          return Promise.resolve({
            rows: [{ acquired: false }] as Row[],
            rowCount: 1,
          });
        },

        release(): Promise<void> {
          releases += 1;
          return Promise.resolve();
        },
      });
    },
  };
  const store = createPgMigrationHistoryStore({ executor });

  assert(store.acquireLock !== undefined);
  assertEquals(await store.acquireLock("tenant-a"), false);
  assertEquals(releases, 1);
});

Deno.test("@sisal/pg - migration history store validates lock ids before sessions", async () => {
  let sessions = 0;
  const executor: SqlExecutor = {
    execute<Row = Record<string, unknown>>(): Promise<QueryResult<Row>> {
      return Promise.resolve({ rows: [], rowCount: 0 });
    },

    acquireSession(): Promise<SqlExecutorSession> {
      sessions += 1;
      return Promise.reject(new Error("session should not be acquired"));
    },
  };
  const store = createPgMigrationHistoryStore({ executor });
  const acquireLock = store.acquireLock;

  assert(acquireLock !== undefined);
  await assertRejects(() => acquireLock(" "));
  assertEquals(sessions, 0);
});

Deno.test("@sisal/pg - acquired sessions do not pin executor queries", async () => {
  const calls: Array<{ readonly client: number; readonly sql: string }> = [];
  const releases: number[] = [];
  let nextClientId = 0;
  const pool: PgPool = {
    connect(): Promise<PgClient> {
      const clientId = ++nextClientId;
      const client: PgClient = {
        queryObject<Row = Record<string, unknown>>(
          query: string,
          _args: unknown[] = [],
        ): Promise<PgDriverResult<Row>> {
          calls.push({ client: clientId, sql: query });

          if (query.includes("pg_try_advisory_lock")) {
            return Promise.resolve({
              rows: [{ acquired: true }] as Row[],
              rowCount: 1,
            });
          }

          if (query.includes("pg_advisory_unlock")) {
            return Promise.resolve({
              rows: [{ released: true }] as Row[],
              rowCount: 1,
            });
          }

          return Promise.resolve({ rows: [], rowCount: 0 });
        },

        release(): void {
          releases.push(clientId);
        },
      };

      return Promise.resolve(client);
    },
  };
  const executor = createPgExecutor({ pool });
  const store = createPgMigrationHistoryStore({ executor });

  assert(store.acquireLock !== undefined);
  assert(store.releaseLock !== undefined);
  assertEquals(await store.acquireLock("tenant-a"), true);
  await executor.execute("select outside_lock");
  await executor.transaction!(async (tx) => {
    await tx.execute("select inside_transaction");
  });
  await store.releaseLock("tenant-a");
  await executor.execute("select after_unlock");

  assertEquals(
    calls.map((call) => call.client),
    [1, 2, 3, 3, 3, 1, 4],
  );
  assert(calls[0].sql.includes("pg_try_advisory_lock"));
  assertEquals(calls[2].sql, "begin");
  assertEquals(calls[4].sql, "commit");
  assert(calls[5].sql.includes("pg_advisory_unlock"));
  assertEquals(releases, [2, 3, 1, 4]);
});
