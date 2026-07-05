import { assertEquals } from "@std/assert";

import { createPgOrmDriver } from "../../src/orm/driver.ts";
import {
  createPgExecutor,
  type PgQueryResult,
  type PgSqlExecutor,
} from "../../src/orm/executor.ts";
import type { PgClient, PgDriverResult, PgPool } from "../../src/orm/pool.ts";

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

Deno.test("@sisal/pg - ORM executor normalizes Temporal params", async () => {
  const client = new RecordingPgClient();
  const pool = new QueuePgPool([client]);
  const executor = createPgExecutor({ pool });

  await executor.execute("insert into events values ($1, $2)", [
    Temporal.PlainDate.from("2026-06-28"),
    [Temporal.Instant.from("2026-06-28T12:00:00.123456789Z")],
  ]);

  assertEquals(client.queries, [
    {
      sql: "insert into events values ($1, $2)",
      params: [
        "2026-06-28",
        ["2026-06-28T12:00:00.123456789Z"],
      ],
    },
  ]);
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

Deno.test("@sisal/pg - a transaction-less executor yields a driver without transaction/batch", () => {
  // The ORM facade then fails closed (ORM_TRANSACTION_UNSUPPORTED) instead of
  // running transaction()/batch() statements non-atomically.
  const executor: PgSqlExecutor = {
    execute<Row = Record<string, unknown>>(): Promise<PgQueryResult<Row>> {
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
  const driver = createPgOrmDriver({ executor });

  assertEquals(driver.transaction, undefined);
  assertEquals(driver.batch, undefined);
});

Deno.test("@sisal/pg - executor coerces float4/float8 → number, int8 → string, keeps numeric strings", async () => {
  // `@db/postgres` hands float4/float8 (OIDs 700/701) back as strings and int8
  // (20) as `BigInt`. The adapter coerces floats to `number` (v0.5 item 11 /
  // v0.9 T5) and int8 to `string` so the Postgres family agrees (v0.9 T7),
  // while leaving `numeric` (1700) a string to preserve precision.
  const client: PgClient = {
    queryObject<Row = Record<string, unknown>>(): Promise<PgDriverResult<Row>> {
      return Promise.resolve({
        rows: [{
          id: 1,
          f4: "1.5",
          f8: "306.25",
          big: 9007199254740993n, // > 2^53 — precision would be lost as a number
          amount: "99.99",
          label: "x",
        }] as Row[],
        rowCount: 1,
        rowDescription: {
          columns: [
            { name: "id", typeOid: 23 }, // int4
            { name: "f4", typeOid: 700 }, // float4 → number
            { name: "f8", typeOid: 701 }, // float8 → number
            { name: "big", typeOid: 20 }, // int8 → string
            { name: "amount", typeOid: 1700 }, // numeric → stays string
            { name: "label", typeOid: 25 }, // text
          ],
        },
      });
    },
    release(): void {},
  };
  const pool: PgPool = { connect: () => Promise.resolve(client) };
  const executor = createPgExecutor({ pool });

  const { rows: [row] } = await executor.execute<{
    id: number;
    f4: unknown;
    f8: unknown;
    big: unknown;
    amount: unknown;
    label: unknown;
  }>("select * from it_floats");

  assertEquals([row.f4, typeof row.f4], [1.5, "number"]);
  assertEquals([row.f8, typeof row.f8], [306.25, "number"]);
  // int8 → string, precision preserved verbatim.
  assertEquals([row.big, typeof row.big], ["9007199254740993", "string"]);
  // numeric + text preserved verbatim (precision-safe).
  assertEquals([row.amount, typeof row.amount], ["99.99", "string"]);
  assertEquals(row.label, "x");
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
