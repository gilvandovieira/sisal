import { assertEquals } from "@std/assert";

import type { SqliteLikeDatabase } from "./database.ts";
import { createSqliteExecutor } from "./executor.ts";

Deno.test("@sisal/sqlite - migration executor normalizes Temporal params", async () => {
  const calls: Array<{
    readonly sql: string;
    readonly params: readonly unknown[];
  }> = [];
  const database: SqliteLikeDatabase = {
    prepare(sql: string) {
      return {
        all(...params: readonly unknown[]) {
          calls.push({ sql, params });
          return [];
        },
        run(...params: readonly unknown[]) {
          calls.push({ sql, params });
          return 0;
        },
      };
    },
    close() {},
  };
  const executor = createSqliteExecutor({ database });

  await executor.execute("insert into migrations values (?, ?)", [
    Temporal.PlainDate.from("2026-06-28"),
    [Temporal.Instant.from("2026-06-28T12:00:00.123456789Z")],
  ]);

  assertEquals(calls, [
    {
      sql: "insert into migrations values (?, ?)",
      params: [
        "2026-06-28",
        ["2026-06-28T12:00:00.123456789Z"],
      ],
    },
  ]);
});
