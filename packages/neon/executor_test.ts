import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";

import {
  createNeonExecutor,
  type NeonClient,
  NeonError,
  type NeonPool,
} from "./mod.ts";

Deno.test("neon executor: pool query executes without acquiring a client", async () => {
  const pool = new FakePool();
  const executor = await createNeonExecutor({ pool });

  const result = await executor.execute<{ one: number }>(
    "select $1::int as one",
    [1],
  );

  assertEquals(result, { rows: [{ one: 1 }], rowCount: 1 });
  assertEquals(pool.connectCount, 0);
  assertEquals(pool.queries, [
    { sql: "select $1::int as one", params: [1] },
  ]);
});

Deno.test("neon executor: transaction uses a pooled client", async () => {
  const pool = new FakePool();
  const executor = await createNeonExecutor({ pool });

  await executor.transaction!(async () => {
    await executor.execute("insert into notes (body) values ($1)", ["ok"]);
  });

  assertEquals(pool.connectCount, 1);
  assertEquals(pool.client.released, true);
  assertEquals(pool.client.queries, [
    { sql: "begin", params: [] },
    { sql: "insert into notes (body) values ($1)", params: ["ok"] },
    { sql: "commit", params: [] },
  ]);
});

Deno.test("neon executor: transaction rolls back on query failure", async () => {
  const pool = new FakePool();
  pool.client.failOnSql = "insert into notes (body) values ($1)";
  const executor = await createNeonExecutor({ pool });

  const error = await assertRejects(
    () =>
      executor.transaction!(async () => {
        await executor.execute("insert into notes (body) values ($1)", ["bad"]);
      }),
    NeonError,
    "Neon query failed",
  );

  assertInstanceOf(error, NeonError);
  assertEquals(error.code, "NEON_EXECUTE_FAILED");
  assertEquals(pool.client.released, true);
  assertEquals(pool.client.queries, [
    { sql: "begin", params: [] },
    { sql: "insert into notes (body) values ($1)", params: ["bad"] },
    { sql: "rollback", params: [] },
  ]);
});

Deno.test("neon executor: closes owned pool", async () => {
  const pool = new FakePool();
  const executor = await createNeonExecutor({ pool, ownsPool: true });

  await executor.close?.();
  await executor.close?.();

  assertEquals(pool.ended, 1);
});

class FakePool implements NeonPool {
  readonly client = new FakeClient();
  readonly queries: QueryCall[] = [];
  connectCount = 0;
  ended = 0;

  query<Row = Record<string, unknown>>(
    sql: string,
    args: unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    this.queries.push({ sql, params: args });
    return Promise.resolve(resultFor<Row>(sql));
  }

  connect(): Promise<NeonClient> {
    this.connectCount += 1;
    return Promise.resolve(this.client);
  }

  end(): Promise<void> {
    this.ended += 1;
    return Promise.resolve();
  }
}

class FakeClient implements NeonClient {
  readonly queries: QueryCall[] = [];
  failOnSql?: string;
  released = false;
  ended = 0;

  query<Row = Record<string, unknown>>(
    sql: string,
    args: unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    this.queries.push({ sql, params: args });

    if (sql === this.failOnSql) {
      return Promise.reject(new Error("boom"));
    }

    return Promise.resolve(resultFor<Row>(sql));
  }

  release(): void {
    this.released = true;
  }

  end(): Promise<void> {
    this.ended += 1;
    return Promise.resolve();
  }
}

interface QueryCall {
  readonly sql: string;
  readonly params: unknown[];
}

function resultFor<Row>(
  sql: string,
): { readonly rows: Row[]; readonly rowCount: number } {
  if (sql === "select $1::int as one") {
    return {
      rows: [{ one: 1 }] as Row[],
      rowCount: 1,
    };
  }

  return {
    rows: [],
    rowCount: 0,
  };
}
