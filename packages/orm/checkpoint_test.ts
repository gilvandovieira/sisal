/**
 * Network-free tests for the ETL checkpoint substrate (`etlCheckpoint`, v0.9
 * T12): `read()` returns the last committed watermark (or null), and `advance()`
 * commits the load and the `window_end` upsert as ONE atomic `db.batch` — the
 * crash-safety invariant. A recording driver captures the batched statements and
 * programs the read result.
 */
import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  createDatabase,
  etlCheckpoint,
  type OrmDriver,
  OrmError,
  type OrmQueryResult,
  sql,
  type SqlQuery,
} from "./mod.ts";

function recordingDriver(
  selectRows: Record<string, unknown>[] = [],
): {
  driver: OrmDriver;
  executed: SqlQuery[];
  batched: SqlQuery[][];
} {
  const executed: SqlQuery[] = [];
  const batched: SqlQuery[][] = [];
  const run = (query: SqlQuery): Promise<OrmQueryResult> => {
    executed.push(query);
    if (query.text.trimStart().toLowerCase().startsWith("select")) {
      return Promise.resolve({ rows: selectRows, rowCount: selectRows.length });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  };
  return {
    driver: {
      query: <T = unknown>(q: SqlQuery) => run(q) as Promise<OrmQueryResult<T>>,
      execute: (q: SqlQuery) => run(q),
      batch(queries) {
        batched.push([...queries]);
        return Promise.resolve(queries.map(() => ({ rows: [], rowCount: 1 })));
      },
    },
    executed,
    batched,
  };
}

Deno.test("checkpoint: read returns the committed watermark", async () => {
  const { driver, executed } = recordingDriver([
    { windowEnd: "2026-03-01T00:00:00.000Z" },
  ]);
  const db = createDatabase({ driver, dialect: "postgres" });

  const cp = etlCheckpoint(db, "hourly-rollup");
  assertEquals(await cp.read(), "2026-03-01T00:00:00.000Z");

  // The table is ensured before the read; the read filters by job.
  assertStringIncludes(
    executed[0].text.toLowerCase(),
    "create table if not exists sisal_etl_checkpoints",
  );
  const select = executed.find((s) =>
    s.text.trimStart().toLowerCase().startsWith("select")
  );
  assert(select, "expected a checkpoint read");
  assertStringIncludes(select.text.toLowerCase(), "window_end");
  assert(select.params.some((p) => p === "hourly-rollup"));
});

Deno.test("checkpoint: read returns null on a fresh job", async () => {
  const { driver } = recordingDriver([]);
  const db = createDatabase({ driver, dialect: "postgres" });
  assertEquals(await etlCheckpoint(db, "fresh").read(), null);
});

Deno.test("checkpoint: readState returns the full contract row", async () => {
  const { driver } = recordingDriver([
    { windowEnd: "w1", prunedBefore: "p0", updatedAt: "u1" },
  ]);
  const db = createDatabase({ driver, dialect: "postgres" });
  assertEquals(await etlCheckpoint(db, "job").readState(), {
    windowEnd: "w1",
    prunedBefore: "p0",
    updatedAt: "u1",
  });
});

Deno.test("checkpoint: readState surfaces a null pruned_before and null row", async () => {
  const withRow = recordingDriver([
    { windowEnd: "w1", prunedBefore: null, updatedAt: "u1" },
  ]);
  const db = createDatabase({ driver: withRow.driver, dialect: "postgres" });
  assertEquals(
    (await etlCheckpoint(db, "job").readState())?.prunedBefore,
    null,
  );

  const empty = recordingDriver([]);
  const freshDb = createDatabase({ driver: empty.driver, dialect: "postgres" });
  assertEquals(await etlCheckpoint(freshDb, "job").readState(), null);
});

Deno.test("checkpoint: advance commits load + watermark as one atomic batch", async () => {
  const { driver, executed, batched } = recordingDriver();
  const db = createDatabase({ driver, dialect: "postgres" });

  const cp = etlCheckpoint(db, "hourly-rollup");
  const load = sql`insert into rollup (k, v) values (1, 2)`;
  await cp.advance("2026-03-02T00:00:00.000Z", [load]);

  // Exactly one atomic batch, load first, watermark upsert last.
  assertEquals(batched.length, 1);
  assertEquals(batched[0].length, 2);
  assertStringIncludes(batched[0][0].text.toLowerCase(), "insert into rollup");
  const watermark = batched[0][1];
  assertStringIncludes(watermark.text.toLowerCase(), "sisal_etl_checkpoints");
  assertStringIncludes(watermark.text.toLowerCase(), "on conflict");
  assertStringIncludes(
    watermark.text.toLowerCase(),
    `excluded."window_end"`,
  );
  assert(watermark.params.some((p) => p === "2026-03-02T00:00:00.000Z"));

  // The table is ensured OUTSIDE the atomic batch (DDL auto-commits on MySQL).
  assertStringIncludes(
    executed[0].text.toLowerCase(),
    "create table if not exists sisal_etl_checkpoints",
  );
});

Deno.test("checkpoint: prune advances the horizon atomically with the delete", async () => {
  const { driver, executed, batched } = recordingDriver();
  const db = createDatabase({ driver, dialect: "postgres" });

  const del = sql`delete from src where ts < '2026-02-01'`;
  await etlCheckpoint(db, "job").prune("2026-02-01", [del]);

  // One atomic batch, source delete first, horizon upsert last.
  assertEquals(batched.length, 1);
  assertEquals(batched[0].length, 2);
  assertStringIncludes(batched[0][0].text.toLowerCase(), "delete from src");
  const horizon = batched[0][1];
  assertStringIncludes(horizon.text.toLowerCase(), "sisal_etl_checkpoints");
  assertStringIncludes(horizon.text.toLowerCase(), "pruned_before");
  assertStringIncludes(horizon.text.toLowerCase(), "on conflict");
  assert(horizon.params.some((p) => p === "2026-02-01"));
  // Table ensured outside the atomic batch.
  assertStringIncludes(
    executed[0].text.toLowerCase(),
    "create table if not exists",
  );
});

Deno.test("checkpoint: assertReplayable enforces the retention horizon", async () => {
  const { driver } = recordingDriver([
    { windowEnd: "2026-03-01", prunedBefore: "2026-02-01", updatedAt: "u" },
  ]);
  const db = createDatabase({ driver, dialect: "postgres" });
  const cp = etlCheckpoint(db, "job");

  // Behind the horizon → refused with the typed ORM_REPLAY_PRUNED error.
  const err = await cp.assertReplayable("2026-01-15").then(
    () => null,
    (e) => e,
  );
  assertInstanceOf(err, OrmError);
  assertEquals(err.code, "ORM_REPLAY_PRUNED");
  assertStringIncludes(err.message, "behind the retention horizon");

  // At / after the horizon → allowed.
  await cp.assertReplayable("2026-02-01");
  await cp.assertReplayable("2026-02-15");
  // Explicit override bypasses the refusal.
  await cp.assertReplayable("2026-01-15", { unsafeAllowPrunedReplay: true });
});

Deno.test("checkpoint: assertReplayable allows any window when the horizon is unset", async () => {
  const { driver } = recordingDriver([]); // no checkpoint row → pruned_before null
  const db = createDatabase({ driver, dialect: "postgres" });
  await etlCheckpoint(db, "job").assertReplayable("2020-01-01"); // no throw
});

Deno.test("checkpoint: prune rejects an empty horizon", async () => {
  const { driver } = recordingDriver();
  const db = createDatabase({ driver, dialect: "postgres" });
  await assertRejects(
    () => etlCheckpoint(db, "job").prune(""),
    OrmError,
    "prune horizon",
  );
});

Deno.test("checkpoint: advance with an empty window still moves the watermark", async () => {
  const { driver, batched } = recordingDriver();
  const db = createDatabase({ driver, dialect: "postgres" });

  await etlCheckpoint(db, "job").advance("wm-1");
  assertEquals(batched[0].length, 1);
  assertStringIncludes(
    batched[0][0].text.toLowerCase(),
    "sisal_etl_checkpoints",
  );
});

Deno.test("checkpoint: honors a custom table name", async () => {
  const { driver, executed, batched } = recordingDriver([]);
  const db = createDatabase({ driver, dialect: "postgres" });

  const cp = etlCheckpoint(db, "job", { table: "my_checkpoints" });
  await cp.read();
  await cp.advance("wm", []);

  for (const statement of [...executed, ...batched.flat()]) {
    const text = statement.text.toLowerCase();
    if (text.includes("checkpoint")) {
      assertStringIncludes(text, "my_checkpoints");
    }
    assertEquals(
      text.includes("sisal_etl_checkpoints"),
      false,
      "custom table must not fall back to the default name",
    );
  }
});

Deno.test("checkpoint: MySQL renders the upsert as a duplicate-key update", async () => {
  const { driver, batched } = recordingDriver();
  const db = createDatabase({ driver, dialect: "mysql" });

  await etlCheckpoint(db, "job").advance("wm", []);
  assertStringIncludes(
    batched[0][0].text.toLowerCase(),
    "on duplicate key update",
  );
});

Deno.test("checkpoint: rejects bad job ids, watermarks, and table names", async () => {
  const { driver } = recordingDriver();
  const db = createDatabase({ driver, dialect: "postgres" });

  assertThrows(() => etlCheckpoint(db, "  "), OrmError, "job id is required");
  assertThrows(
    () => etlCheckpoint(db, "job", { table: "a; drop table x" }),
    OrmError,
    "plain identifier",
  );
  const cp = etlCheckpoint(db, "job");
  await assertRejects(() => cp.advance(""), OrmError, "watermark");
  await assertRejects(() => cp.advance("x".repeat(65)), OrmError, "at most 64");
});
