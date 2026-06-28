import { assert, assertEquals } from "@std/assert";
import {
  createMigrator,
  defineSqlMigration,
  memoryMigrationStore,
  type MigrationDriver,
} from "./mod.ts";

// Records each execute() call, standing in for a single-statement transport.
function recordingDriver(): {
  driver: MigrationDriver;
  readonly executed: string[];
} {
  const executed: string[] = [];
  return {
    executed,
    driver: {
      execute(sql: string): Promise<void> {
        executed.push(sql);
        return Promise.resolve();
      },
    },
  };
}

const migration = defineSqlMigration({
  id: "0001_fn",
  up: "create table t (id int);\n" +
    "create function f() returns int as $$ begin return 1; end; $$ " +
    "language plpgsql;\n" +
    "insert into t values (1);",
});

Deno.test("migrator: splitStatements applies a .sql file one statement at a time", async () => {
  const { driver, executed } = recordingDriver();
  const store = memoryMigrationStore();
  const migrator = createMigrator({
    migrations: [migration],
    driver,
    store,
    splitStatements: true,
    useTransaction: false,
  });

  const result = await migrator.up();

  assertEquals(result.executed.map((m) => m.id), ["0001_fn"]);
  // Three separate execute() calls — never a single multi-statement query.
  assertEquals(executed.length, 3);
  // The dollar-quoted function body (with internal `;`) stays intact.
  assert(executed[1].includes("$$ begin return 1; end; $$"), executed[1]);
  // History is still recorded.
  assertEquals((await store.listApplied()).map((m) => m.id), ["0001_fn"]);
});

Deno.test("migrator: without splitStatements the file is one execute() call", async () => {
  const { driver, executed } = recordingDriver();
  const migrator = createMigrator({
    migrations: [migration],
    driver,
    store: memoryMigrationStore(),
    useTransaction: false,
  });

  await migrator.up();

  assertEquals(executed.length, 1);
  assert(executed[0].includes("create table t"), executed[0]);
  assert(executed[0].includes("insert into t"), executed[0]);
});
