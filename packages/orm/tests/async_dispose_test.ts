import { assertEquals, assertRejects } from "@std/assert";
import { createDatabase, type OrmDriver } from "../mod.ts";

function countingDriver(counter: { closed: number }): OrmDriver {
  return {
    query: () => Promise.resolve({ rows: [], rowCount: 0 }),
    execute: () => Promise.resolve({ rows: [], rowCount: 0 }),
    close: () => {
      counter.closed += 1;
      return Promise.resolve();
    },
  };
}

Deno.test("database: await using closes the driver at scope exit", async () => {
  const counter = { closed: 0 };
  {
    await using db = createDatabase({
      dialect: "postgres",
      driver: countingDriver(counter),
    });
    await db.execute("select 1");
    assertEquals(counter.closed, 0);
  }
  assertEquals(counter.closed, 1);
});

Deno.test("database: await using still closes when the scope throws", async () => {
  const counter = { closed: 0 };
  await assertRejects(
    async () => {
      await using db = createDatabase({
        dialect: "postgres",
        driver: countingDriver(counter),
      });
      await db.execute("select 1");
      throw new Error("boom");
    },
    Error,
    "boom",
  );
  assertEquals(counter.closed, 1);
});

Deno.test("database: Symbol.asyncDispose delegates to close()", async () => {
  const counter = { closed: 0 };
  const db = createDatabase({
    dialect: "postgres",
    driver: countingDriver(counter),
  });
  await db[Symbol.asyncDispose]();
  assertEquals(counter.closed, 1);
});
