/**
 * Network-free tests for the portable advisory lock (`db.tryAdvisoryLock`, v0.9
 * T11): the lock-row lease claims a free name, refuses a held one, releases only
 * its own row, renews / reports a lost lease, disposes via `await using`, and
 * fails closed on the `generic` dialect. A recording driver stands in for a real
 * adapter, programming the insert/update row counts the lease logic branches on.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  createDatabase,
  type OrmDriver,
  OrmError,
  type OrmQueryResult,
  type SqlQuery,
} from "./mod.ts";

// A driver that records every rendered statement and models who holds the
// name. `insert: 1` (default) makes our insert win — the claim then verifies
// ownership by reading the row back, so the SELECT must return our own token.
// `insert: 0` stands in for a conflict (another live holder), so the verify
// SELECT returns a different owner and the claim is refused.
function recordingDriver(
  counts: { insert?: number; update?: number } = {},
): { driver: OrmDriver; statements: SqlQuery[] } {
  const statements: SqlQuery[] = [];
  const insertRows = counts.insert ?? 1;
  const updateRows = counts.update ?? 1;
  // The owner the verify SELECT reports. Set from the insert's params on a win,
  // or a foreign token on a conflict.
  let heldOwner: string | undefined;
  const run = (query: SqlQuery): Promise<OrmQueryResult> => {
    statements.push(query);
    const head = query.text.trimStart().toLowerCase();
    if (head.startsWith("insert")) {
      // Values render in declaration order: name, owner, expires_at.
      heldOwner = insertRows >= 1
        ? (query.params[1] as string)
        : "__other_holder__";
      return Promise.resolve({
        rows: insertRows >= 1 ? [{ n: 1 }] : [],
        rowCount: insertRows,
      });
    }
    if (head.startsWith("select")) {
      return Promise.resolve({
        rows: heldOwner === undefined ? [] : [{ owner: heldOwner }],
        rowCount: heldOwner === undefined ? 0 : 1,
      });
    }
    if (head.startsWith("update")) {
      return Promise.resolve({ rows: [], rowCount: updateRows });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  };
  return {
    driver: {
      query: <T = unknown>(q: SqlQuery) => run(q) as Promise<OrmQueryResult<T>>,
      execute: (q: SqlQuery) => run(q),
    },
    statements,
  };
}

function lastText(statements: SqlQuery[]): string {
  return statements[statements.length - 1].text.toLowerCase();
}

Deno.test("advisory lock: claims a free name and emits the lease DML", async () => {
  const { driver, statements } = recordingDriver({ insert: 1 });
  const db = createDatabase({ driver, dialect: "postgres" });

  const lock = await db.tryAdvisoryLock("sisal:etl:daily");

  assertEquals(lock.acquired, true);
  assertEquals(typeof lock.owner, "string");
  // Ensure-table, reap-expired, then claim-if-absent.
  assertStringIncludes(
    statements[0].text.toLowerCase(),
    "create table if not exists sisal_advisory_locks",
  );
  const reap = statements[1];
  assertStringIncludes(reap.text.toLowerCase(), "delete from");
  // Reap compares the lease as an ISO-8601 string (lexicographic == chrono).
  assert(
    typeof reap.params[1] === "string" &&
      /^\d{4}-\d\d-\d\dt/i.test(reap.params[1] as string),
    `reap should carry an ISO lease bound, got ${reap.params[1]}`,
  );
  const insert = statements.find((s) =>
    s.text.trimStart().toLowerCase().startsWith("insert")
  );
  assert(insert, "expected a claim insert");
  assertStringIncludes(insert.text.toLowerCase(), "on conflict do nothing");
});

Deno.test("advisory lock: release deletes only this owner's row, once", async () => {
  const { driver, statements } = recordingDriver({ insert: 1 });
  const db = createDatabase({ driver, dialect: "postgres" });

  const lock = await db.tryAdvisoryLock("job");
  const owner = lock.owner;
  const before = statements.length;

  await lock.release();
  assertEquals(statements.length, before + 1);
  assertStringIncludes(lastText(statements), "delete from");
  assert(
    statements[statements.length - 1].params.some((p) => p === owner),
    "release must filter by the owner token",
  );

  // Idempotent: a second release (and disposal) emits nothing more.
  await lock.release();
  await lock[Symbol.asyncDispose]();
  assertEquals(statements.length, before + 1);
});

Deno.test("advisory lock: refuses a held name and stays inert", async () => {
  const { driver, statements } = recordingDriver({ insert: 0 });
  const db = createDatabase({ driver, dialect: "postgres" });

  const lock = await db.tryAdvisoryLock("held");
  assertEquals(lock.acquired, false);
  assertEquals(lock.owner, undefined);

  const before = statements.length;
  assertEquals(await lock.renew(), false);
  await lock.release();
  await lock[Symbol.asyncDispose]();
  // A refused lock never touches the table again.
  assertEquals(statements.length, before);
});

Deno.test("advisory lock: renew extends a live lease and reports a lost one", async () => {
  const held = recordingDriver({ insert: 1, update: 1 });
  const heldDb = createDatabase({ driver: held.driver, dialect: "postgres" });
  const live = await heldDb.tryAdvisoryLock("job");
  assertEquals(await live.renew(), true);
  assertStringIncludes(lastText(held.statements), "update");

  const lost = recordingDriver({ insert: 1, update: 0 });
  const lostDb = createDatabase({ driver: lost.driver, dialect: "postgres" });
  const stolen = await lostDb.tryAdvisoryLock("job");
  assertEquals(await stolen.renew(), false);
});

Deno.test("advisory lock: `await using` releases on scope exit", async () => {
  const { driver, statements } = recordingDriver({ insert: 1 });
  const db = createDatabase({ driver, dialect: "postgres" });

  let owner: string | undefined;
  {
    await using lock = await db.tryAdvisoryLock("scoped");
    owner = lock.owner;
    assertEquals(lock.acquired, true);
  }

  assertStringIncludes(lastText(statements), "delete from");
  assert(
    statements[statements.length - 1].params.some((p) => p === owner),
    "scope-exit disposal must release the held lease",
  );
});

Deno.test("advisory lock: MySQL uses the no-op upsert, not ON CONFLICT", async () => {
  const { driver, statements } = recordingDriver({ insert: 1 });
  const db = createDatabase({ driver, dialect: "mysql" });

  await db.tryAdvisoryLock("job");
  const insert = statements.find((s) =>
    s.text.trimStart().toLowerCase().startsWith("insert")
  );
  assert(insert, "expected a claim insert");
  assertStringIncludes(insert.text.toLowerCase(), "on duplicate key update");
});

// A single in-memory lock table shared by every claimant that uses this
// driver. The `insert` deliberately reports `rowCount: 1` even for a
// conflicting no-op — the exact found-rows-style ambiguity behind SEC-008 — so
// a count-based claim would double-grant. Only the racer whose insert actually
// set `owner` may win, and the verify SELECT is what enforces that.
function sharedLockStore(): { driver(): OrmDriver } {
  let owner: string | undefined;
  const run = (query: SqlQuery): Promise<OrmQueryResult> => {
    const head = query.text.trimStart().toLowerCase();
    if (head.startsWith("insert")) {
      if (owner === undefined) {
        owner = query.params[1] as string; // name, owner, expires_at
      }
      // Ambiguous count: 1 for both a real insert and a conflicting no-op.
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (head.startsWith("select")) {
      return Promise.resolve({
        rows: owner === undefined ? [] : [{ owner }],
        rowCount: owner === undefined ? 0 : 1,
      });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  };
  const driver: OrmDriver = {
    query: <T = unknown>(q: SqlQuery) => run(q) as Promise<OrmQueryResult<T>>,
    execute: (q: SqlQuery) => run(q),
  };
  return { driver: () => driver };
}

Deno.test("advisory lock: two racers, exactly one wins under the found-rows-ambiguous count (SEC-008)", async () => {
  const store = sharedLockStore();
  const a = createDatabase({ driver: store.driver(), dialect: "mysql" });
  const b = createDatabase({ driver: store.driver(), dialect: "mysql" });

  const [lockA, lockB] = await Promise.all([
    a.tryAdvisoryLock("etl:daily"),
    b.tryAdvisoryLock("etl:daily"),
  ]);

  assertEquals(
    [lockA.acquired, lockB.acquired].filter(Boolean).length,
    1,
    "exactly one racer may hold the lock even though the driver reports one " +
      "affected row for the losing conflict",
  );
});

Deno.test("advisory lock: honors a custom table name", async () => {
  const { driver, statements } = recordingDriver({ insert: 1 });
  const db = createDatabase({ driver, dialect: "postgres" });

  const lock = await db.tryAdvisoryLock("job", { table: "etl_run_locks" });
  assertEquals(lock.acquired, true);
  // The DDL + every DML statement targets the user's table, never our default.
  assertStringIncludes(statements[0].text.toLowerCase(), "etl_run_locks");
  for (const statement of statements) {
    assertEquals(
      statement.text.toLowerCase().includes("sisal_advisory_locks"),
      false,
      "custom table must not fall back to the default name",
    );
  }
});

Deno.test("advisory lock: rejects an unsafe table name", async () => {
  const { driver } = recordingDriver();
  const db = createDatabase({ driver, dialect: "postgres" });
  await assertRejects(
    () => db.tryAdvisoryLock("job", { table: "locks; drop table users" }),
    OrmError,
    "plain identifier",
  );
});

Deno.test("advisory lock: fails closed on the generic dialect", async () => {
  const db = createDatabase({ dialect: "generic" });
  await assertRejects(
    () => db.tryAdvisoryLock("job"),
    OrmError,
    "generic",
  );
});

Deno.test("advisory lock: rejects an empty or oversized name", async () => {
  const { driver } = recordingDriver();
  const db = createDatabase({ driver, dialect: "postgres" });
  await assertRejects(
    () => db.tryAdvisoryLock("   "),
    OrmError,
    "name is required",
  );
  await assertRejects(
    () => db.tryAdvisoryLock("x".repeat(256)),
    OrmError,
    "at most 255",
  );
});
