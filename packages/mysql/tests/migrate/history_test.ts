import { assert, assertEquals, assertRejects } from "@std/assert";

import type {
  MysqlClient,
  MysqlDriverRows,
  MysqlPool,
} from "../../src/orm/pool.ts";
import {
  createMysqlMigrateExecutor,
  type QueryResult,
  type SqlExecutor,
  type SqlExecutorSession,
} from "../../src/migrate/executor.ts";
import {
  createMysqlMigrationHistoryStore,
  DEFAULT_MYSQL_MIGRATION_TABLE,
} from "../../src/migrate/history.ts";
import { createMysqlMigrator } from "../../src/migrate/migrator.ts";

interface QueryCall {
  readonly sql: string;
  readonly params: readonly unknown[];
}

Deno.test("@sisal/mysql - migration history store omits locks without pinned sessions", () => {
  const executor: SqlExecutor = {
    execute<Row = Record<string, unknown>>(): Promise<QueryResult<Row>> {
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
  const store = createMysqlMigrationHistoryStore({ executor });

  assertEquals(store.acquireLock, undefined);
  assertEquals(store.releaseLock, undefined);
  assertEquals(DEFAULT_MYSQL_MIGRATION_TABLE, "sisal_migrations");
});

Deno.test("@sisal/mysql - migration history store uses GET_LOCK named locks", async () => {
  const calls: QueryCall[] = [];
  let releases = 0;
  const session: SqlExecutorSession = {
    execute<Row = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<Row>> {
      calls.push({ sql, params });

      // The mandated bigint-as-string driver options decode GET_LOCK's
      // BIGINT result as the string "1" — the store must coerce it.
      if (sql.includes("get_lock")) {
        return Promise.resolve({
          rows: [{ acquired: "1" }] as Row[],
          rowCount: 1,
        });
      }

      if (sql.includes("release_lock")) {
        return Promise.resolve({
          rows: [{ released: "1" }] as Row[],
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
  const store = createMysqlMigrationHistoryStore({ executor });

  assert(store.acquireLock !== undefined);
  assert(store.releaseLock !== undefined);
  assertEquals(await store.acquireLock("tenant-a"), true);
  assertEquals(await store.acquireLock("tenant-a"), false);
  await store.releaseLock("tenant-a");

  assertEquals(releases, 1);
  assertEquals(calls.length, 2);
  assert(calls[0].sql.includes("get_lock(?, 0)"));
  assert(calls[1].sql.includes("release_lock(?)"));
  // Lock names pass through verbatim (no hashing, unlike pg's bigint keys).
  assertEquals(calls[0].params[0], "tenant-a");
  assertEquals(calls[1].params[0], "tenant-a");
});

Deno.test("@sisal/mysql - default migration lock is namespaced by database (SEC-013)", async () => {
  const calls: QueryCall[] = [];
  const session: SqlExecutorSession = {
    execute<Row = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<Row>> {
      calls.push({ sql, params });
      if (sql.includes("database()")) {
        return Promise.resolve({
          rows: [{ db: "shop" }] as Row[],
          rowCount: 1,
        });
      }
      if (sql.includes("get_lock")) {
        return Promise.resolve({
          rows: [{ acquired: "1" }] as Row[],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    release: () => Promise.resolve(),
  };
  const executor: SqlExecutor = {
    execute: () => Promise.resolve({ rows: [], rowCount: 0 }),
    acquireSession: () => Promise.resolve(session),
  };
  const store = createMysqlMigrationHistoryStore({ executor });

  assert(store.acquireLock !== undefined);
  // No explicit lock id → the store resolves the current database and scopes
  // the lock to it, so a different database's migrator is not blocked.
  assertEquals(await store.acquireLock(), true);
  const getLock = calls.find((c) => c.sql.includes("get_lock"));
  assert(getLock, "expected a get_lock call");
  assertEquals(getLock.params[0], "sisal:migrate:shop");
});

Deno.test("@sisal/mysql - migration history store releases busy lock sessions", async () => {
  let releases = 0;
  const executor: SqlExecutor = {
    execute<Row = Record<string, unknown>>(): Promise<QueryResult<Row>> {
      return Promise.resolve({ rows: [], rowCount: 0 });
    },

    acquireSession(): Promise<SqlExecutorSession> {
      return Promise.resolve({
        execute<Row = Record<string, unknown>>(): Promise<QueryResult<Row>> {
          return Promise.resolve({
            rows: [{ acquired: 0 }] as Row[],
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
  const store = createMysqlMigrationHistoryStore({ executor });

  assert(store.acquireLock !== undefined);
  assertEquals(await store.acquireLock("tenant-a"), false);
  assertEquals(releases, 1);
});

Deno.test("@sisal/mysql - migration history store validates lock ids before sessions", async () => {
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
  const store = createMysqlMigrationHistoryStore({ executor });
  const acquireLock = store.acquireLock;

  assert(acquireLock !== undefined);
  await assertRejects(() => acquireLock(" "));
  // GET_LOCK names cap at 64 characters — validated before any session.
  await assertRejects(() => acquireLock("x".repeat(65)));
  assertEquals(sessions, 0);
});

Deno.test("@sisal/mysql - history ledger uses MySQL-safe DDL and Date params", async () => {
  const calls: QueryCall[] = [];
  const executor: SqlExecutor = {
    execute<Row = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<Row>> {
      calls.push({ sql, params });

      if (sql.includes("order by id asc")) {
        return Promise.resolve({
          rows: [{
            id: "0001_init",
            checksum: "abc",
            description: null,
            appliedAt: new Date("2026-07-01T12:00:00.000Z"),
            executionMs: 12.5,
          }] as Row[],
          rowCount: 1,
        });
      }

      return Promise.resolve({ rows: [], rowCount: 1 });
    },
  };
  const store = createMysqlMigrationHistoryStore({ executor });

  await store.markApplied({
    id: "0001_init",
    checksum: "abc",
    appliedAt: "2026-07-01T12:00:00.000Z",
  });

  // ensure + insert
  assertEquals(calls.length, 2);
  const ddl = calls[0].sql;
  // The ledger obeys the adapter's own B5 rules: no TEXT key, DATETIME(6).
  assert(ddl.includes("id varchar(255) primary key"));
  assert(ddl.includes("applied_at datetime(6) not null"));
  assert(calls[1].sql.includes("values (?, ?, ?, ?, ?)"));
  assert(calls[1].params[3] instanceof Date);

  const applied = await store.listApplied();
  assertEquals(applied, [{
    id: "0001_init",
    checksum: "abc",
    appliedAt: "2026-07-01T12:00:00.000Z",
    executionMs: 12.5,
  }]);

  assertEquals(await store.unmarkApplied("0001_init"), true);
});

function fakePool(handler: (sql: string) => MysqlDriverRows) {
  const calls: Array<{ readonly client: number; readonly sql: string }> = [];
  const releases: number[] = [];
  let nextClientId = 0;
  const pool: MysqlPool = {
    getConnection(): Promise<MysqlClient> {
      const clientId = ++nextClientId;
      const client: MysqlClient = {
        query<Row = Record<string, unknown>>(
          sql: string,
        ): Promise<[MysqlDriverRows<Row>, unknown]> {
          calls.push({ client: clientId, sql });
          return Promise.resolve([handler(sql) as MysqlDriverRows<Row>, []]);
        },

        release(): void {
          releases.push(clientId);
        },
      };

      return Promise.resolve(client);
    },
  };
  return { pool, calls, releases };
}

Deno.test("@sisal/mysql - lock sessions stay pinned to one connection", async () => {
  const { pool, calls, releases } = fakePool((sql) => {
    if (sql.includes("get_lock")) return [{ acquired: "1" }];
    if (sql.includes("release_lock")) return [{ released: "1" }];
    if (sql.trimStart().startsWith("select")) return [];
    return { affectedRows: 0 };
  });
  const executor = createMysqlMigrateExecutor({ pool });
  const store = createMysqlMigrationHistoryStore({ executor });

  assert(store.acquireLock !== undefined);
  assert(store.releaseLock !== undefined);
  assertEquals(await store.acquireLock("tenant-a"), true);
  await executor.execute("select outside_lock");
  await executor.transaction!(async (tx) => {
    await tx.execute("select inside_transaction");
  });
  await store.releaseLock("tenant-a");
  await executor.execute("select after_unlock");

  // GET_LOCK and RELEASE_LOCK ran on client 1; everything else got its own
  // pooled connection — MySQL named locks are connection-scoped.
  assertEquals(
    calls.map((call) => call.client),
    [1, 2, 3, 3, 3, 1, 4],
  );
  assert(calls[0].sql.includes("get_lock"));
  assertEquals(calls[2].sql, "begin");
  assertEquals(calls[4].sql, "commit");
  assert(calls[5].sql.includes("release_lock"));
  assertEquals(releases, [2, 3, 1, 4]);
});

Deno.test("@sisal/mysql - migrator applies migrations under the named lock", async () => {
  const history: Record<string, unknown>[] = [];
  const { pool, calls } = fakePool((sql) => {
    if (sql.includes("get_lock")) return [{ acquired: "1" }];
    if (sql.includes("release_lock")) return [{ released: "1" }];
    if (sql.includes("order by id asc")) return [...history];
    if (sql.trimStart().startsWith("insert into `sisal_migrations`")) {
      history.push({
        id: "0001_users",
        checksum:
          "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        appliedAt: new Date("2026-07-01T12:00:00.000Z"),
        executionMs: 1,
      });
      return { affectedRows: 1 };
    }
    if (sql.trimStart().startsWith("select")) return [];
    return { affectedRows: 0 };
  });

  const migrator = await createMysqlMigrator({ pool });
  const result = await migrator.migrate({
    migrations: [{
      id: "0001_users",
      up:
        "CREATE TABLE `users` (\n  `id` INT NOT NULL,\n  PRIMARY KEY (`id`)\n);",
    }],
  });

  assertEquals(result.executed.length, 1);
  assertEquals(result.executed[0].id, "0001_users");

  const sqls = calls.map((call) => call.sql);
  const lockIndex = sqls.findIndex((sql) => sql.includes("get_lock"));
  const createIndex = sqls.findIndex((sql) => sql.includes("CREATE TABLE"));
  const unlockIndex = sqls.findIndex((sql) => sql.includes("release_lock"));
  assert(lockIndex >= 0 && createIndex > lockIndex);
  assert(unlockIndex > createIndex);

  const applied = await migrator.applied();
  assertEquals(applied.length, 1);
  await migrator.close();
});
