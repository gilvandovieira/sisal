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
import { type Database, defineAtomicOperation } from "../mod.ts";

// A fake Database whose transaction() runs the callback, recording lifecycle.
function fakeDb(log: string[], dialect = "generic"): Database {
  const db = {
    dialect,
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

// A config-form op: the single-statement path returns 1, the body 2 — so the
// chosen path is observable from the result and the lifecycle log.
function dispatchOp(log: string[]) {
  return defineAtomicOperation<void, number>("dispatch", {
    body: (_tx) => {
      log.push("body");
      return Promise.resolve(2);
    },
    singleStatement: (_db) => {
      log.push("single");
      return Promise.resolve(1);
    },
  });
}

Deno.test("atomic operation: Postgres runs the single statement (no transaction)", async () => {
  const log: string[] = [];
  const db = fakeDb(log, "postgres");
  assertEquals(await dispatchOp(log).run(db, undefined), 1);
  assertEquals(log, ["single"]); // no begin/commit — one statement is atomic
});

Deno.test("atomic operation: the SQLite family runs the interactive body", async () => {
  const log: string[] = [];
  const db = fakeDb(log, "sqlite");
  assertEquals(await dispatchOp(log).run(db, undefined), 2);
  assertEquals(log, ["begin", "body", "commit"]);
});

Deno.test("atomic operation: body-only op ignores dialect (always interactive)", async () => {
  const log: string[] = [];
  const db = fakeDb(log, "postgres");
  const op = defineAtomicOperation<void, number>("body_only", (_tx) => {
    log.push("body");
    return Promise.resolve(7);
  });
  assertEquals(await op.run(db, undefined), 7);
  assertEquals(log, ["begin", "body", "commit"]);
});
