import { assertEquals } from "@std/assert";

import { createPgOrmDriver } from "./driver.ts";
import {
  createPgExecutor,
  type PgQueryResult,
  type PgSqlExecutor,
} from "./executor.ts";
import type { PgClient, PgDriverResult, PgPool } from "./pool.ts";

Deno.test("@sisal/pg - ORM executor isolates transaction client", async () => {
  const transactionClient = new RecordingPgClient();
  const outsideClient = new RecordingPgClient();
  const pool = new QueuePgPool([transactionClient, outsideClient]);
  const executor = createPgExecutor({ pool });

  await executor.transaction!(async (tx) => {
    await tx.execute("insert into notes values ($1)", ["tx"]);
    await executor.execute("select outside");
  });

  assertEquals(transactionClient.queries, [
    { sql: "begin", params: [] },
    { sql: "insert into notes values ($1)", params: ["tx"] },
    { sql: "commit", params: [] },
  ]);
  assertEquals(outsideClient.queries, [
    { sql: "select outside", params: [] },
  ]);
  assertEquals(transactionClient.released, true);
  assertEquals(outsideClient.released, true);
});

Deno.test("@sisal/pg - ORM driver uses scoped transaction executor", async () => {
  const outerQueries: QueryCall[] = [];
  const transactionQueries: QueryCall[] = [];
  const transactionExecutor = recordingExecutor(transactionQueries);
  const executor: PgSqlExecutor = {
    execute<Row = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<PgQueryResult<Row>> {
      outerQueries.push({ sql, params: [...params] });
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    transaction<T>(fn: (tx: PgSqlExecutor) => Promise<T>): Promise<T> {
      return fn(transactionExecutor);
    },
  };
  const driver = createPgOrmDriver({ executor });

  await driver.transaction!(async (tx) => {
    await tx.execute({ text: "insert into notes values ($1)", params: ["tx"] });
  });

  assertEquals(outerQueries, []);
  assertEquals(transactionQueries, [
    { sql: "insert into notes values ($1)", params: ["tx"] },
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

function recordingExecutor(calls: QueryCall[]): PgSqlExecutor {
  return {
    execute<Row = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<PgQueryResult<Row>> {
      calls.push({ sql, params: [...params] });
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
}
