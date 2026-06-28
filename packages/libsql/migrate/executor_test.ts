import { assertEquals } from "@std/assert";

import type {
  LibsqlClient,
  LibsqlStatement,
  LibsqlTransaction,
} from "../client.ts";
import { createLibsqlMigrationDriver } from "./driver.ts";
import {
  createLibsqlExecutor,
  type QueryResult,
  type SqlExecutor,
} from "./executor.ts";

Deno.test("@sisal/libsql - migration executor isolates transaction handle", async () => {
  const events: string[] = [];
  let transactionExecuteCount = 0;
  const transaction: LibsqlTransaction = {
    execute() {
      transactionExecuteCount++;
      return Promise.resolve({ rows: [], rowsAffected: 1 });
    },
    commit() {
      events.push("commit");
      return Promise.resolve();
    },
    rollback() {
      events.push("rollback");
      return Promise.resolve();
    },
    close() {
      events.push("close");
    },
  };
  const client: LibsqlClient = {
    execute(statement: LibsqlStatement | string) {
      const sql = typeof statement === "string" ? statement : statement.sql;
      events.push(`client:${sql}`);
      return Promise.resolve({ rows: [], rowsAffected: 1 });
    },
    transaction(mode) {
      events.push(`transaction:${mode}`);
      return Promise.resolve(transaction);
    },
  };
  const executor = createLibsqlExecutor({ client });

  await executor.transaction!(async (tx) => {
    await tx.execute("insert into migrations values (1)");
    await executor.execute("select outside");
  });

  assertEquals(transactionExecuteCount, 1);
  assertEquals(events, [
    "transaction:write",
    "client:select outside",
    "commit",
    "close",
  ]);
});

Deno.test("@sisal/libsql - migration executor normalizes Temporal params", async () => {
  let seen: LibsqlStatement | undefined;
  const client: LibsqlClient = {
    execute(statement) {
      seen = statement as LibsqlStatement;
      return Promise.resolve({ rows: [], rowsAffected: 1 });
    },
  };
  const executor = createLibsqlExecutor({ client });

  await executor.execute("insert into migrations values (?, ?)", [
    Temporal.PlainDate.from("2026-06-28"),
    [Temporal.Instant.from("2026-06-28T12:00:00.123456789Z")],
  ]);

  assertEquals(seen, {
    sql: "insert into migrations values (?, ?)",
    args: [
      "2026-06-28",
      '["2026-06-28T12:00:00.123456789Z"]',
    ],
  });
});

Deno.test("@sisal/libsql - migration driver uses scoped transaction executor", async () => {
  const outerQueries: QueryCall[] = [];
  const transactionQueries: QueryCall[] = [];
  const transactionExecutor = recordingExecutor(transactionQueries);
  const executor: SqlExecutor = {
    execute<Row = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<Row>> {
      outerQueries.push({ sql, params: [...params] });
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      return fn(transactionExecutor);
    },
  };
  const driver = createLibsqlMigrationDriver({ executor });

  await driver.transaction!(async (tx) => {
    await tx.driver.execute("insert into migrations values (1)");
  });

  assertEquals(outerQueries, []);
  assertEquals(transactionQueries, [
    { sql: "insert into migrations values (1)", params: [] },
  ]);
});

interface QueryCall {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function recordingExecutor(calls: QueryCall[]): SqlExecutor {
  return {
    execute<Row = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<Row>> {
      calls.push({ sql, params: [...params] });
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
}
