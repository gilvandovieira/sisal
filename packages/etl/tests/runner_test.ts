/**
 * Network-free tests for the single-window runner (v0.10 T16): `run()`
 * acquires the job's advisory lock, computes the next window from the
 * checkpoint, sends the generated rollup and the watermark upsert as ONE
 * atomic `db.batch`, and reports typed outcomes for `locked` / `up-to-date`.
 * A recording driver stands in for a real adapter, modeling the lock table
 * and the checkpoint read.
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
import { defineJob, run } from "../mod.ts";

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

/**
 * Models just enough engine for one run: the advisory-lock claim insert
 * (win/lose), the lock-row verify select, and the checkpoint read select.
 */
function recordingDriver(
  state: { lockWinner?: boolean; watermark?: string | null } = {},
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
    if (head.startsWith("select")) {
      const rows = state.watermark == null
        ? []
        : [{ windowEnd: state.watermark }];
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

const NOW = new Date("2026-01-01T05:30:00Z");

Deno.test("run: folds the next window and advances atomically", async () => {
  const { driver, executed, batched } = recordingDriver({
    watermark: "2026-01-01T02:00:00.000Z",
  });
  const db = createDatabase({ driver, dialect: "postgres" });

  const outcome = await run(db, job, { now: NOW });
  assertEquals(outcome, {
    ran: true,
    window: {
      from: "2026-01-01T02:00:00.000Z",
      until: "2026-01-01T03:00:00.000Z",
    },
  });

  // ONE batch: the rollup, then the watermark upsert — atomic load+advance.
  assertEquals(batched.length, 1);
  assertEquals(batched[0].length, 2);
  assertStringIncludes(
    batched[0][0].text.toLowerCase(),
    'insert into "post_hourly_stats"',
  );
  assertStringIncludes(batched[0][0].text.toLowerCase(), "on conflict");
  assert(batched[0][0].params.includes("2026-01-01T02:00:00.000Z"));
  assert(batched[0][0].params.includes("2026-01-01T03:00:00.000Z"));
  assertStringIncludes(
    batched[0][1].text.toLowerCase(),
    "sisal_etl_checkpoints",
  );
  assert(batched[0][1].params.includes("2026-01-01T03:00:00.000Z"));

  // The lock is claimed under the job's namespaced name and released after.
  const claim = executed.find((q) =>
    q.text.includes("advisory_locks") &&
    q.text.trimStart().toLowerCase().startsWith("insert")
  );
  assert(claim, "expected an advisory-lock claim");
  assert(claim.params.includes("sisal:etl:post-hourly-stats"));
  const release = executed[executed.length - 1];
  assertStringIncludes(release.text.toLowerCase(), "delete from");
  assertStringIncludes(release.text, "advisory_locks");
});

Deno.test("run: a fresh job starts from the job's start", async () => {
  const { driver, batched } = recordingDriver({ watermark: null });
  const db = createDatabase({ driver, dialect: "postgres" });

  const outcome = await run(db, job, { now: NOW });
  assertEquals(outcome, {
    ran: true,
    window: {
      from: "2026-01-01T00:00:00.000Z",
      until: "2026-01-01T01:00:00.000Z",
    },
  });
  assertEquals(batched.length, 1);
});

Deno.test("run: up-to-date when the next bucket has not closed", async () => {
  const { driver, batched, executed } = recordingDriver({
    watermark: "2026-01-01T05:00:00.000Z",
  });
  const db = createDatabase({ driver, dialect: "postgres" });

  const outcome = await run(db, job, { now: NOW });
  assertEquals(outcome, { ran: false, reason: "up-to-date" });
  assertEquals(batched.length, 0);
  // Even a no-op run releases the lock.
  assertStringIncludes(
    executed[executed.length - 1].text.toLowerCase(),
    "delete from",
  );
});

Deno.test("run: steps aside when another runner holds the lock", async () => {
  const { driver, batched, executed } = recordingDriver({ lockWinner: false });
  const db = createDatabase({ driver, dialect: "postgres" });

  const outcome = await run(db, job, { now: NOW });
  assertEquals(outcome, { ran: false, reason: "locked" });
  assertEquals(batched.length, 0);
  // The loser never touches the checkpoint table.
  assertEquals(
    executed.some((q) => q.text.includes("sisal_etl_checkpoints")),
    false,
  );
});

Deno.test("run: releases the lock when the window math throws", async () => {
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
  const { driver, executed } = recordingDriver({ watermark: null });
  const db = createDatabase({ driver, dialect: "postgres" });

  let code: string | undefined;
  try {
    await run(db, startless, { now: NOW });
  } catch (error) {
    code = (error as { code?: string }).code;
  }
  assertEquals(code, "ETL_MISSING_START");
  assertStringIncludes(
    executed[executed.length - 1].text.toLowerCase(),
    "delete from",
  );
});
