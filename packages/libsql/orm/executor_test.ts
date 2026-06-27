import { assertEquals, assertRejects } from "@std/assert";
import { sql } from "@sisal/orm";

import type {
  LibsqlClient,
  LibsqlStatement,
  LibsqlTransaction,
} from "../client.ts";
import { createLibsqlDb } from "./mod.ts";
import { createLibsqlExecutor } from "./executor.ts";

Deno.test("@sisal/libsql - executor runs statements through client", async () => {
  const calls: LibsqlStatement[] = [];
  const client: LibsqlClient = {
    execute<Row = Record<string, unknown>>(
      statement: LibsqlStatement | string,
    ) {
      calls.push(statement as LibsqlStatement);
      return Promise.resolve({
        rows: [{ one: 1 }] as Row[],
        rowsAffected: 0,
      });
    },
  };

  const executor = createLibsqlExecutor({ client });
  const result = await executor.execute<{ one: number }>("select ? as one", [
    1,
  ]);

  assertEquals(result.rows, [{ one: 1 }]);
  assertEquals(result.rowCount, 0);
  assertEquals(calls, [{ sql: "select ? as one", args: [1] }]);
});

Deno.test("@sisal/libsql - executor normalizes JSON-like params", async () => {
  let seen: LibsqlStatement | undefined;
  const client: LibsqlClient = {
    execute(statement) {
      seen = statement as LibsqlStatement;
      return Promise.resolve({ rows: [], rowsAffected: 1 });
    },
  };

  const executor = createLibsqlExecutor({ client });
  await executor.execute("insert into docs values (?, ?)", [
    { note: "x" },
    ["a", "b"],
  ]);

  assertEquals(seen, {
    sql: "insert into docs values (?, ?)",
    args: ['{"note":"x"}', '["a","b"]'],
  });
});

Deno.test("@sisal/libsql - database facade uses SQLite parameter rendering", async () => {
  const calls: LibsqlStatement[] = [];
  const client: LibsqlClient = {
    execute<Row = Record<string, unknown>>(
      statement: LibsqlStatement | string,
    ) {
      calls.push(statement as LibsqlStatement);
      return Promise.resolve({
        rows: [{ who: "sisal" }] as Row[],
        rowsAffected: 0,
      });
    },
  };
  const db = await createLibsqlDb({ client });

  const result = await db.query<{ who: string }>(
    sql`select ${"sisal"} as who`,
  );

  assertEquals(result.rows, [{ who: "sisal" }]);
  assertEquals(calls, [{ sql: "select ? as who", args: ["sisal"] }]);
});

Deno.test("@sisal/libsql - transaction commits and rolls back", async () => {
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
    execute() {
      events.push("client.execute");
      return Promise.resolve({ rows: [], rowsAffected: 1 });
    },
    transaction(mode) {
      events.push(`transaction:${mode}`);
      return Promise.resolve(transaction);
    },
  };

  const executor = createLibsqlExecutor({ client });
  await executor.transaction!(() =>
    executor.execute("insert into x values (1)")
  );
  await assertRejects(() =>
    executor.transaction!(async () => {
      await executor.execute("insert into x values (2)");
      throw new Error("boom");
    })
  );

  assertEquals(transactionExecuteCount, 2);
  assertEquals(events, [
    "transaction:write",
    "commit",
    "close",
    "transaction:write",
    "rollback",
    "close",
  ]);
});
