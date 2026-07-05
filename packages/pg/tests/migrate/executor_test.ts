import { assertEquals } from "@std/assert";

import { createPgMigrationDriver } from "../../src/migrate/driver.ts";
import {
  createPgExecutor,
  type QueryResult,
  type SqlExecutor,
} from "../../src/migrate/executor.ts";
import type {
  PgClient,
  PgDriverResult,
  PgPool,
} from "../../src/migrate/pool.ts";

Deno.test("@sisal/pg - migration executor isolates transaction client", async () => {
  const transactionClient = new RecordingPgClient();
  const outsideClient = new RecordingPgClient();
  const pool = new QueuePgPool([transactionClient, outsideClient]);
  const executor = createPgExecutor({ pool });

  await executor.transaction!(async (tx) => {
    await tx.execute("insert into migrations values ($1)", ["tx"]);
    await executor.execute("select outside");
  });

  assertEquals(transactionClient.queries, [
    { sql: "begin", params: [] },
    { sql: "insert into migrations values ($1)", params: ["tx"] },
    { sql: "commit", params: [] },
  ]);
  assertEquals(outsideClient.queries, [
    { sql: "select outside", params: [] },
  ]);
  assertEquals(transactionClient.released, true);
  assertEquals(outsideClient.released, true);
});

Deno.test("@sisal/pg - migration executor normalizes Temporal params", async () => {
  const client = new RecordingPgClient();
  const pool = new QueuePgPool([client]);
  const executor = createPgExecutor({ pool });

  await executor.execute("insert into migrations values ($1, $2)", [
    Temporal.PlainDate.from("2026-06-28"),
    [Temporal.Instant.from("2026-06-28T12:00:00.123456789Z")],
  ]);

  assertEquals(client.queries, [
    {
      sql: "insert into migrations values ($1, $2)",
      params: [
        "2026-06-28",
        ["2026-06-28T12:00:00.123456789Z"],
      ],
    },
  ]);
});

Deno.test("@sisal/pg - migration driver uses scoped transaction executor", async () => {
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
  const driver = createPgMigrationDriver({ executor });

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

class RecordingPgClient implements PgClient {
  readonly queries: QueryCall[] = [];
  released = false;

  queryObject<Row = Record<string, unknown>>(
    sql: string,
    args: unknown[] = [],
  ): Promise<PgDriverResult<Row>> {
    this.queries.push({ sql, params: [...args] });
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  release(): void {
    this.released = true;
  }
}

class QueuePgPool implements PgPool {
  readonly #clients: RecordingPgClient[];

  constructor(clients: RecordingPgClient[]) {
    this.#clients = [...clients];
  }

  connect(): Promise<PgClient> {
    const client = this.#clients.shift();

    if (client === undefined) {
      return Promise.reject(new Error("no queued client"));
    }

    return Promise.resolve(client);
  }
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
