/**
 * Unit tests for the SQLite executor's transaction serialization.
 *
 * SQLite is single-connection, so the executor must hold that connection
 * exclusively for the duration of a `BEGIN…COMMIT`. These tests use a fake
 * database (no `@db/sqlite`, no FFI) to assert that unrelated work on the same
 * executor queues behind an open transaction instead of leaking into it.
 */
import { assertEquals, assertRejects } from "@std/assert";

import { createSqliteExecutor } from "./executor.ts";
import type { SqliteLikeDatabase } from "./database.ts";

// A fake database that records every executed statement in order.
function fakeDatabase(log: string[]): SqliteLikeDatabase {
  return {
    prepare(sql: string) {
      return {
        all(..._params: readonly unknown[]) {
          log.push(sql);
          return [];
        },
        run(..._params: readonly unknown[]) {
          log.push(sql);
          return 0;
        },
      };
    },
    close() {},
  };
}

Deno.test("sqlite executor: outside work queues behind an open transaction", async () => {
  const log: string[] = [];
  const executor = createSqliteExecutor({ database: fakeDatabase(log) });

  let releaseInside!: () => void;
  const insideGate = new Promise<void>((resolve) => {
    releaseInside = resolve;
  });

  // Start a transaction that holds itself open mid-way via `insideGate`.
  const txPromise = executor.transaction!(async (tx) => {
    await tx.execute("insert 1");
    await insideGate;
    await tx.execute("insert 2");
  });

  // Fire an unrelated statement on the SAME executor while the transaction is
  // still open. It must not interleave between BEGIN and COMMIT.
  const outsidePromise = executor.execute("insert outside");

  // Let the transaction reach its gate, then release it.
  await Promise.resolve();
  releaseInside();
  await txPromise;
  await outsidePromise;

  assertEquals(log, [
    "begin",
    "insert 1",
    "insert 2",
    "commit",
    "insert outside",
  ]);
});

Deno.test("sqlite executor: transaction rolls back and preserves the error", async () => {
  const log: string[] = [];
  const executor = createSqliteExecutor({ database: fakeDatabase(log) });

  await assertRejects(
    () =>
      executor.transaction!(async (tx) => {
        await tx.execute("insert 1");
        throw new Error("boom");
      }),
    Error,
    "boom",
  );

  assertEquals(log, ["begin", "insert 1", "rollback"]);
});

Deno.test("sqlite executor: sequential transactions never overlap", async () => {
  const log: string[] = [];
  const executor = createSqliteExecutor({ database: fakeDatabase(log) });

  // Two transactions kicked off without awaiting the first must serialize.
  const first = executor.transaction!(async (tx) => {
    await tx.execute("a1");
    await tx.execute("a2");
  });
  const second = executor.transaction!(async (tx) => {
    await tx.execute("b1");
  });
  await Promise.all([first, second]);

  assertEquals(log, [
    "begin",
    "a1",
    "a2",
    "commit",
    "begin",
    "b1",
    "commit",
  ]);
});
