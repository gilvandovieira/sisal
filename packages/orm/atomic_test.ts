/**
 * Portable atomic operations / "transaction scripts" (v0.5.0 roadmap item 8).
 * `defineAtomicOperation` runs an authored body inside one transaction on any
 * adapter. These network-free tests pin the wrapping (begin/commit/rollback and
 * result flow); the per-adapter integration suites exercise real
 * read-modify-write + rollback against a database.
 *
 * @module
 */
import { assertEquals, assertRejects } from "@std/assert";
import { type Database, defineAtomicOperation } from "./mod.ts";

// A fake Database whose transaction() runs the callback, recording lifecycle.
function fakeDb(log: string[]): Database {
  const db = {
    transaction: async <T>(fn: (tx: Database) => Promise<T>): Promise<T> => {
      log.push("begin");
      try {
        const result = await fn(db);
        log.push("commit");
        return result;
      } catch (error) {
        log.push("rollback");
        throw error;
      }
    },
  } as unknown as Database;
  return db;
}

Deno.test("atomic operation runs the body in a transaction and returns its result", async () => {
  const log: string[] = [];
  const db = fakeDb(log);
  const op = defineAtomicOperation<{ x: number }, number>(
    "double",
    (_tx, input) => {
      log.push("body");
      return Promise.resolve(input.x * 2);
    },
  );
  assertEquals(op.name, "double");
  assertEquals(await op.run(db, { x: 21 }), 42);
  assertEquals(log, ["begin", "body", "commit"]);
});

Deno.test("atomic operation rolls back and propagates on error", async () => {
  const log: string[] = [];
  const db = fakeDb(log);
  const op = defineAtomicOperation<void, never>("boom", () => {
    log.push("body");
    return Promise.reject(new Error("nope"));
  });
  await assertRejects(() => op.run(db, undefined), Error, "nope");
  assertEquals(log, ["begin", "body", "rollback"]);
});

Deno.test("atomic operation passes the transaction-scoped db to the body", async () => {
  const log: string[] = [];
  const db = fakeDb(log);
  let received: Database | undefined;
  const op = defineAtomicOperation<void, void>("capture", (tx) => {
    received = tx;
    return Promise.resolve();
  });
  await op.run(db, undefined);
  assertEquals(received, db);
});
