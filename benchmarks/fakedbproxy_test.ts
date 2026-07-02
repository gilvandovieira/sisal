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
