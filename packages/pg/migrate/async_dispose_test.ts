import { assert } from "@std/assert";
import type { QueryResult, SqlExecutor } from "./executor.ts";
import { createPgMigrator } from "./migrator.ts";

Deno.test("@sisal/pg - await using closes the migrator at scope exit", async () => {
  let closed = 0;
  const executor: SqlExecutor = {
    execute<Row = Record<string, unknown>>(): Promise<QueryResult<Row>> {
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    close(): Promise<void> {
      closed += 1;
      return Promise.resolve();
    },
  };

  {
    await using migrator = await createPgMigrator({ executor });
    await migrator.applied();
  }

  assert(closed >= 1);
});
