import { assertEquals, assertRejects } from "@std/assert";

import { createFakeDbProxy } from "./fakedbproxy.ts";

Deno.test("fake db proxy records ORM calls and synthetic rows", async () => {
  const proxy = createFakeDbProxy({ rows: 2 });
  const driver = proxy.asOrmDriver();

  const result = await driver.query({
    text: "select * from users where id = $1",
    params: ["u_1"],
  });

  assertEquals(result.rows.length, 2);
  assertEquals(result.rowCount, 2);
  assertEquals(proxy.stats.queries, 1);
  assertEquals(proxy.stats.paramsObserved, 1);
  assertEquals(proxy.calls[0]?.sql, "select * from users where id = $1");
});

Deno.test("fake db proxy records migration transactions", async () => {
  const proxy = createFakeDbProxy();
  const driver = proxy.asMigrationDriver();

  await driver.transaction?.(async () => {
    await driver.execute("select 1;");
  });

  assertEquals(proxy.stats.transactions, 1);
  assertEquals(proxy.stats.executes, 1);
  assertEquals(proxy.calls.map((call) => call.operation), [
    "transaction",
    "execute",
  ]);
  assertEquals(proxy.calls[1]?.transactionDepth, 1);
});

Deno.test("fake db proxy failure rules fail deterministically", async () => {
  const proxy = createFakeDbProxy({
    failures: {
      operation: "execute",
      sqlIncludes: "boom",
      message: "planned fake failure",
    },
  });
  const executor = proxy.asSqlExecutor();

  await assertRejects(
    () => executor.execute("select boom"),
    Error,
    "planned fake failure",
  );

  assertEquals(proxy.stats.failures, 1);
  assertEquals(proxy.calls[0]?.failed, true);
});

Deno.test("fake db proxy Drizzle pg proxy maps all to query", async () => {
  const proxy = createFakeDbProxy({
    rows: [{ id: 1, email: "ada@example.com" }],
  });
  const drizzleProxy = proxy.asDrizzlePgProxy({
    columns: ["id", "email"],
  });

  const result = await drizzleProxy(
    "select id, email from users",
    [],
    "all",
  );

  assertEquals(result.rows, [[1, "ada@example.com"]]);
  assertEquals(proxy.stats.queries, 1);
  assertEquals(proxy.stats.executes, 0);
});

Deno.test("fake db proxy Drizzle pg proxy maps execute to execute", async () => {
  const proxy = createFakeDbProxy({
    rows: [{ id: 1, email: "ada@example.com" }],
  });
  const drizzleProxy = proxy.asDrizzlePgProxy({
    columns: ["id", "email"],
  });

  const result = await drizzleProxy(
    "update users set email = $1 where id = $2",
    ["ada@lovelace.test", 1],
    "execute",
  );

  assertEquals(result.rows, []);
  assertEquals(proxy.stats.queries, 0);
  assertEquals(proxy.stats.executes, 1);
});

Deno.test("fake db proxy Drizzle pg proxy uses explicit column order", async () => {
  const proxy = createFakeDbProxy({
    rows: [{ email: "grace@example.com", id: 2 }],
  });
  const drizzleProxy = proxy.asDrizzlePgProxy({
    columns: ["id", "email"],
  });

  const result = await drizzleProxy(
    "select id, email from users",
    [],
    "all",
  );

  assertEquals(result.rows, [[2, "grace@example.com"]]);
});

Deno.test("fake db proxy Drizzle pg proxy preserves failure rules", async () => {
  const proxy = createFakeDbProxy({
    failures: {
      sqlIncludes: "boom",
      message: "planned drizzle fake failure",
    },
  });
  const drizzleProxy = proxy.asDrizzlePgProxy();

  await assertRejects(
    () => drizzleProxy("select boom", [], "all"),
    Error,
    "planned drizzle fake failure",
  );

  assertEquals(proxy.stats.failures, 1);
  assertEquals(proxy.calls[0]?.failed, true);
});
