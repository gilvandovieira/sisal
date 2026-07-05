import { assertEquals, assertRejects } from "@std/assert";
import {
  createMigrator,
  memoryMigrationStore,
  type MigrationDriver,
} from "../mod.ts";

function countingDriver(counter: { closed: number }): MigrationDriver {
  return {
    execute: () => Promise.resolve(),
    close: () => {
      counter.closed += 1;
      return Promise.resolve();
    },
  };
}

Deno.test("migrator: await using closes store + driver at scope exit", async () => {
  const counter = { closed: 0 };
  {
    await using migrator = createMigrator({
      migrations: [],
      store: memoryMigrationStore(),
      driver: countingDriver(counter),
    });
    await migrator.plan();
    assertEquals(counter.closed, 0);
  }
  assertEquals(counter.closed, 1);
});

Deno.test("migrator: await using still closes when the scope throws", async () => {
  const counter = { closed: 0 };
  await assertRejects(
    async () => {
      await using migrator = createMigrator({
        migrations: [],
        store: memoryMigrationStore(),
        driver: countingDriver(counter),
      });
      await migrator.plan();
      throw new Error("boom");
    },
    Error,
    "boom",
  );
  assertEquals(counter.closed, 1);
});
