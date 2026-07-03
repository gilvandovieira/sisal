/**
 * Network-free tests for the ETL API fan-out (v0.10 T17–T19): `backfill`
 * walks an explicit range as successive idempotent windows, `replay` re-runs
 * one window behind the replay-horizon guard (`ORM_REPLAY_PRUNED` + the loud
 * unsafe override), and `status` reports checkpoint + next window read-only.
 * None of the three ever advances the watermark. A recording driver stands in
 * for a real adapter, modeling the lock table and the checkpoint row.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  columns,
  count,
  createDatabase,
  defineTable,
  eq,
  filter,
  type OrmDriver,
  type OrmQueryResult,
  primaryKey,
  type SqlQuery,
  sum,
} from "@sisal/orm";
import { backfill, defineJob, replay, status } from "./mod.ts";

const postEvents = defineTable("post_events", {
  id: columns.bigserial().primaryKey(),
  post_id: columns.bigint().notNull(),
  kind: columns.text().notNull(),
  score: columns.integer().notNull(),
  occurred_at: columns.timestamp({ withTimezone: true, mode: "date" })
    .notNull(),
});

const postHourlyStats = defineTable("post_hourly_stats", {
  post_id: columns.bigint().notNull(),
  bucket: columns.timestamp({ withTimezone: true, mode: "date" }).notNull(),
  views: columns.integer().notNull(),
  score: columns.integer().notNull(),
}, (c) => [primaryKey({ columns: [c.post_id, c.bucket] })]);

const e = postEvents.columns;

const job = defineJob({
  name: "post-hourly-stats",
  source: postEvents,
  target: postHourlyStats,
  window: e.occurred_at,
  grain: "hour",
  bucket: "bucket",
  groupBy: { post_id: e.post_id },
  aggregates: {
    views: filter(count(), eq(e.kind, "view")),
    score: sum(e.score),
  },
  start: "2026-01-01T00:00:00.000Z",
});

interface DriverState {
  readonly lockWinner?: boolean;
  readonly watermark?: string | null;
  readonly prunedBefore?: string | null;
}

/**
 * Models just enough engine for the API tier: the advisory-lock lease, the
 * checkpoint row (watermark + retention horizon), and everything else a
 * recorded no-op.
 */
function recordingDriver(
  state: DriverState = {},
): { driver: OrmDriver; executed: SqlQuery[]; batched: SqlQuery[][] } {
  const lockWinner = state.lockWinner ?? true;
  const executed: SqlQuery[] = [];
  const batched: SqlQuery[][] = [];
  let heldOwner: string | undefined;
  const run = (query: SqlQuery): Promise<OrmQueryResult> => {
    executed.push(query);
    const head = query.text.trimStart().toLowerCase();
    if (head.startsWith("insert") && query.text.includes("advisory_locks")) {
      heldOwner = lockWinner ? (query.params[1] as string) : "__other_holder__";
      return Promise.resolve({
        rows: lockWinner ? [{ n: 1 }] : [],
        rowCount: lockWinner ? 1 : 0,
      });
    }
    if (head.startsWith("select") && query.text.includes("advisory_locks")) {
      return Promise.resolve({
        rows: heldOwner === undefined ? [] : [{ owner: heldOwner }],
        rowCount: heldOwner === undefined ? 0 : 1,
      });
    }
    if (
      head.startsWith("select") && query.text.includes("sisal_etl_checkpoints")
    ) {
      const rows = state.watermark == null ? [] : [{
        windowEnd: state.watermark,
        prunedBefore: state.prunedBefore ?? null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }];
      return Promise.resolve({ rows, rowCount: rows.length });
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

const rollups = (executed: SqlQuery[]): SqlQuery[] =>
  executed.filter((q) =>
    q.text.trimStart().toLowerCase().startsWith(
      'insert into "post_hourly_stats"',
    )
  );

Deno.test("backfill: walks the range as successive windows, no advance", async () => {
  const { driver, executed, batched } = recordingDriver({
    watermark: "2026-02-01T00:00:00.000Z",
  });
  const db = createDatabase({ driver, dialect: "postgres" });

  const outcome = await backfill(db, job, {
    from: "2026-01-01T00:00:00Z",
    until: "2026-01-01T03:00:00Z",
  });
  assert(outcome.ran);
  assertEquals(outcome.windows.length, 3);
  assertEquals(outcome.windows[0], {
    from: "2026-01-01T00:00:00.000Z",
    until: "2026-01-01T01:00:00.000Z",
  });

  // Three rollup statements, in order, each binding its own window.
  const sent = rollups(executed);
  assertEquals(sent.length, 3);
  assert(sent[2].params.includes("2026-01-01T02:00:00.000Z"));
  assert(sent[2].params.includes("2026-01-01T03:00:00.000Z"));
  // Historical re-runs never touch the watermark: no batch, no checkpoint
  // write.
  assertEquals(batched.length, 0);
  assertEquals(
    executed.some((q) =>
      q.text.includes("sisal_etl_checkpoints") &&
      !q.text.trimStart().toLowerCase().startsWith("select") &&
      !q.text.trimStart().toLowerCase().startsWith("create table")
    ),
    false,
  );
});

Deno.test("backfill: refuses a range behind the retention horizon", async () => {
  const { driver, executed } = recordingDriver({
    watermark: "2026-02-01T00:00:00.000Z",
    prunedBefore: "2026-01-15T00:00:00.000Z",
  });
  const db = createDatabase({ driver, dialect: "postgres" });

  let code: string | undefined;
  try {
    await backfill(db, job, {
      from: "2026-01-01T00:00:00Z",
      until: "2026-01-02T00:00:00Z",
    });
  } catch (error) {
    code = (error as { code?: string }).code;
  }
  assertEquals(code, "ORM_REPLAY_PRUNED");
  // Nothing was folded, and the lock was still released.
  assertEquals(rollups(executed).length, 0);
  assertStringIncludes(
    executed[executed.length - 1].text.toLowerCase(),
    "delete from",
  );
});

Deno.test("backfill: steps aside when another runner holds the lock", async () => {
  const { driver, executed } = recordingDriver({ lockWinner: false });
  const db = createDatabase({ driver, dialect: "postgres" });

  const outcome = await backfill(db, job, {
    from: "2026-01-01T00:00:00Z",
    until: "2026-01-01T02:00:00Z",
  });
  assertEquals(outcome, { ran: false, reason: "locked" });
  assertEquals(rollups(executed).length, 0);
});

Deno.test("replay: re-runs one window idempotently, no advance", async () => {
  const { driver, executed, batched } = recordingDriver({
    watermark: "2026-02-01T00:00:00.000Z",
  });
  const db = createDatabase({ driver, dialect: "postgres" });

  const outcome = await replay(db, job, "2026-01-05T10:00:00Z");
  assertEquals(outcome, {
    ran: true,
    window: {
      from: "2026-01-05T10:00:00.000Z",
      until: "2026-01-05T11:00:00.000Z",
    },
  });
  const sent = rollups(executed);
  assertEquals(sent.length, 1);
  assertStringIncludes(sent[0].text.toLowerCase(), "on conflict");
  assertEquals(batched.length, 0);
});

Deno.test("replay: refuses a pruned window; unsafe override runs it loudly", async () => {
  const state = {
    watermark: "2026-02-01T00:00:00.000Z",
    prunedBefore: "2026-01-15T00:00:00.000Z",
  };
  const refused = recordingDriver(state);
  const db = createDatabase({ driver: refused.driver, dialect: "postgres" });

  let code: string | undefined;
  try {
    await replay(db, job, "2026-01-05T10:00:00Z");
  } catch (error) {
    code = (error as { code?: string }).code;
  }
  assertEquals(code, "ORM_REPLAY_PRUNED");
  assertEquals(rollups(refused.executed).length, 0);

  // The deliberate override re-derives from a restored source — and runs.
  const overridden = recordingDriver(state);
  const db2 = createDatabase({
    driver: overridden.driver,
    dialect: "postgres",
  });
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (message: string) => warnings.push(message);
  try {
    const outcome = await replay(db2, job, "2026-01-05T10:00:00Z", {
      unsafeAllowPrunedReplay: true,
    });
    assert(outcome.ran);
  } finally {
    console.warn = warn;
  }
  assertEquals(rollups(overridden.executed).length, 1);
  // The bypass never passes silently (SEC-012).
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "unsafeAllowPrunedReplay");
});

Deno.test("status: reports checkpoint and the next window, read-only", async () => {
  const { driver, executed, batched } = recordingDriver({
    watermark: "2026-01-02T03:00:00.000Z",
    prunedBefore: "2026-01-01T00:00:00.000Z",
  });
  const db = createDatabase({ driver, dialect: "postgres" });

  const report = await status(db, job, {
    now: new Date("2026-01-02T05:30:00Z"),
  });
  assertEquals(report, {
    job: "post-hourly-stats",
    checkpoint: {
      windowEnd: "2026-01-02T03:00:00.000Z",
      prunedBefore: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    next: {
      from: "2026-01-02T03:00:00.000Z",
      until: "2026-01-02T04:00:00.000Z",
    },
  });
  // Read-only: no lock rows, no writes, no batches.
  assertEquals(
    executed.some((q) => q.text.includes("advisory_locks")),
    false,
  );
  assertEquals(batched.length, 0);
});

Deno.test("status: a fresh job reports its start-derived next window", async () => {
  const { driver } = recordingDriver({ watermark: null });
  const db = createDatabase({ driver, dialect: "postgres" });

  const report = await status(db, job, {
    now: new Date("2026-01-01T05:30:00Z"),
  });
  assertEquals(report.checkpoint, null);
  assertEquals(report.next, {
    from: "2026-01-01T00:00:00.000Z",
    until: "2026-01-01T01:00:00.000Z",
  });
});

Deno.test("status: fresh with no start, or up to date, reports next: null", async () => {
  const startless = defineJob({
    name: "no-start",
    source: postEvents,
    target: postHourlyStats,
    window: e.occurred_at,
    grain: "hour",
    bucket: "bucket",
    groupBy: { post_id: e.post_id },
    aggregates: {
      views: filter(count(), eq(e.kind, "view")),
      score: sum(e.score),
    },
  });
  const fresh = recordingDriver({ watermark: null });
  const freshDb = createDatabase({ driver: fresh.driver, dialect: "postgres" });
  assertEquals(
    (await status(freshDb, startless, { now: new Date("2026-01-01") })).next,
    null,
  );

  const caughtUp = recordingDriver({ watermark: "2026-01-01T05:00:00.000Z" });
  const caughtUpDb = createDatabase({
    driver: caughtUp.driver,
    dialect: "postgres",
  });
  assertEquals(
    (await status(caughtUpDb, job, { now: new Date("2026-01-01T05:30:00Z") }))
      .next,
    null,
  );
});
