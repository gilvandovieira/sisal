/**
 * ETL integration suite for `@sisal/etl` (v0.10 T23) — the
 * `post_events → post_hourly_stats` rollup end to end against a real
 * PostgreSQL server, discharging the release's acceptance criteria:
 *
 * - **pushed-down SQL** — the `explain()` dry-run output executes verbatim;
 * - **resume** — `run()` folds one window per call and the checkpoint
 *   advances, so successive runs walk successive windows;
 * - **idempotency** — replaying a window leaves the target byte-identical;
 * - **backfill** — an explicit historical range reproduces the same state
 *   deterministically after the target is wiped;
 * - **lock contention** — two runners, one winner (deterministic held-lock
 *   refusal, plus a concurrent race that must never double-count);
 * - **replay horizon** — a window behind `pruned_before` is refused with
 *   `ORM_REPLAY_PRUNED`, and the unsafe override re-derives it.
 *
 * Every marker is a fixed instant and `now` is injected, so the suite is
 * deterministic regardless of wall clock. Gated on `DATABASE_URL` (skipped
 * when unset), like `pg_features_test.ts`. Run:
 *
 *   DATABASE_URL=postgres://postgres:postgres@localhost:55418/sisal \
 *     deno test --allow-net --allow-env --allow-read \
 *     integration/etl_features_test.ts
 *
 * @module
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  columns,
  count,
  defineTable,
  eq,
  etlCheckpoint,
  filter,
  OrmError,
} from "@sisal/orm";
import {
  backfill,
  defineJob,
  explain,
  replay,
  run,
  status,
  supportsJob,
} from "@sisal/etl";
import { connect, type PgDatabase } from "@sisal/pg";
import { env } from "./_shared/env.ts";

const URL = env("DATABASE_URL");
const SKIP = URL === undefined;

// Suite-private physical names so nothing collides with the other suites or
// the default system tables.
const EVENTS = "it_etl_events";
const HOURLY = "it_etl_hourly";
const CHECKPOINTS = "it_etl_checkpoints";
const LOCKS = "it_etl_locks";
const JOB_NAME = "it-post-hourly-stats";

const postEvents = defineTable(EVENTS, {
  id: columns.bigserial().primaryKey(),
  post_id: columns.bigint().notNull(),
  kind: columns.text().notNull(),
  occurred_at: columns.timestamp({ withTimezone: true, mode: "date" })
    .notNull(),
});

const postHourlyStats = defineTable(HOURLY, {
  post_id: columns.bigint().notNull(),
  bucket: columns.timestamp({ withTimezone: true, mode: "date" }).notNull(),
  views: columns.integer().notNull(),
  votes: columns.integer().notNull(),
  comments: columns.integer().notNull(),
});

const e = postEvents.columns;

const T0 = "2026-01-01T00:00:00.000Z";
const at = (offsetMinutes: number): Date =>
  new Date(new Date(T0).getTime() + offsetMinutes * 60_000);
// All buckets through [03:00, 04:00) are closed at NOW; the last one is empty.
const NOW = at(4 * 60);

const job = defineJob({
  name: JOB_NAME,
  source: postEvents,
  target: postHourlyStats,
  window: e.occurred_at,
  grain: "hour",
  bucket: "bucket",
  groupBy: { post_id: e.post_id },
  aggregates: {
    views: filter(count(), eq(e.kind, "view")),
    votes: filter(count(), eq(e.kind, "vote")),
    comments: filter(count(), eq(e.kind, "comment")),
  },
  start: T0,
});

const OPTIONS = {
  checkpointTable: CHECKPOINTS,
  lock: { table: LOCKS },
} as const;

// Deterministic traffic across three hourly buckets (bucket offset in
// minutes, post, kind):
const SEED: readonly [number, string, string][] = [
  // [00:00, 01:00): p1 → 3 views, 1 vote, 1 comment; p2 → 1 view
  [10, "1", "view"],
  [20, "1", "view"],
  [30, "1", "view"],
  [40, "1", "vote"],
  [50, "1", "comment"],
  [15, "2", "view"],
  // [01:00, 02:00): p1 → 2 views; p2 → 1 vote, 2 comments
  [70, "1", "view"],
  [80, "1", "view"],
  [75, "2", "vote"],
  [85, "2", "comment"],
  [95, "2", "comment"],
  // [02:00, 03:00): p2 → 1 view, 1 vote
  [130, "2", "view"],
  [140, "2", "vote"],
];

interface HourlyRow {
  readonly post_id: string;
  readonly bucket: string;
  readonly views: number;
  readonly votes: number;
  readonly comments: number;
}

/** The target state the full [00:00, 03:00) fold must always produce. */
const EXPECTED: readonly HourlyRow[] = [
  { bucket: T0, post_id: "1", views: 3, votes: 1, comments: 1 },
  { bucket: T0, post_id: "2", views: 1, votes: 0, comments: 0 },
  {
    bucket: at(60).toISOString(),
    post_id: "1",
    views: 2,
    votes: 0,
    comments: 0,
  },
  {
    bucket: at(60).toISOString(),
    post_id: "2",
    views: 0,
    votes: 1,
    comments: 2,
  },
  {
    bucket: at(120).toISOString(),
    post_id: "2",
    views: 1,
    votes: 1,
    comments: 0,
  },
];

async function reset(db: PgDatabase): Promise<void> {
  for (const table of [EVENTS, HOURLY, CHECKPOINTS, LOCKS]) {
    await db.execute(`drop table if exists ${table}`);
  }
  await db.execute(
    `create table ${EVENTS} (id bigserial primary key, ` +
      `post_id bigint not null, kind text not null, ` +
      `occurred_at timestamptz not null)`,
  );
  await db.execute(
    `create table ${HOURLY} (post_id bigint not null, ` +
      `bucket timestamptz not null, views integer not null, ` +
      `votes integer not null, comments integer not null, ` +
      `primary key (post_id, bucket))`,
  );
  await db.insert(postEvents).values(
    SEED.map(([minutes, post_id, kind]) => ({
      post_id,
      kind,
      occurred_at: at(minutes),
    })),
  ).execute();
}

async function readHourly(db: PgDatabase): Promise<HourlyRow[]> {
  const s = postHourlyStats.columns;
  const rows = await db.select({
    post_id: s.post_id,
    bucket: s.bucket,
    views: s.views,
    votes: s.votes,
    comments: s.comments,
  }).from(postHourlyStats).execute();
  return rows.map((row) => ({
    ...row,
    bucket: new Date(row.bucket as unknown as string).toISOString(),
  })).sort((a, b) =>
    a.bucket === b.bucket
      ? a.post_id.localeCompare(b.post_id)
      : a.bucket.localeCompare(b.bucket)
  );
}

/** Drains every closed bucket; returns how many windows folded. */
async function catchUp(db: PgDatabase, now = NOW): Promise<number> {
  let folded = 0;
  while ((await run(db, job, { ...OPTIONS, now })).ran) folded += 1;
  return folded;
}

function etlTest(
  name: string,
  fn: (db: PgDatabase, db2: PgDatabase) => Promise<void>,
) {
  Deno.test({
    name,
    ignore: SKIP,
    sanitizeResources: false,
    sanitizeOps: false,
    fn: async () => {
      const db = await connect({ url: URL! });
      const db2 = await connect({ url: URL! });
      try {
        await reset(db);
        await fn(db, db2);
      } finally {
        await db2.close();
        await db.close();
      }
    },
  });
}

etlTest("etl: capability gate passes on the live identity", (db) => {
  assertEquals(supportsJob(job, db.dialectIdentity), { supported: true });
  return Promise.resolve();
});

etlTest("etl: the dry-run SQL executes verbatim (pushed-down)", async (db) => {
  const window = { from: T0, until: at(60).toISOString() };
  const explained = explain(job, window, { dialect: "postgres" });
  await db.execute(explained.text, explained.params);
  assertEquals(await readHourly(db), EXPECTED.slice(0, 2));
});

etlTest("etl: run folds one window per call and resumes", async (db) => {
  const first = await run(db, job, { ...OPTIONS, now: NOW });
  assert(first.ran);
  assertEquals(first.window, { from: T0, until: at(60).toISOString() });
  assertEquals(await readHourly(db), EXPECTED.slice(0, 2));

  const second = await run(db, job, { ...OPTIONS, now: NOW });
  assert(second.ran);
  assertEquals(second.window.from, at(60).toISOString());

  // Drain the rest: [02:00, 03:00) plus the empty [03:00, 04:00).
  assertEquals(await catchUp(db), 2);
  assertEquals(await readHourly(db), EXPECTED);

  const report = await status(db, job, { ...OPTIONS, now: NOW });
  assertEquals(report.checkpoint?.windowEnd, NOW.toISOString());
  assertEquals(report.next, null); // up to date
});

etlTest("etl: replaying a window leaves the target identical", async (db) => {
  await catchUp(db);
  const before = await readHourly(db);

  const outcome = await replay(db, job, at(60).toISOString(), OPTIONS);
  assert(outcome.ran);
  assertEquals(await readHourly(db), before);

  // The checkpoint did not move — replay rewrites history, not the resume
  // point.
  const report = await status(db, job, { ...OPTIONS, now: NOW });
  assertEquals(report.checkpoint?.windowEnd, NOW.toISOString());
});

etlTest(
  "etl: backfill reproduces a wiped range deterministically",
  async (db) => {
    await catchUp(db);
    assertEquals(await readHourly(db), EXPECTED);

    await db.execute(`delete from ${HOURLY}`);
    const outcome = await backfill(
      db,
      job,
      { from: T0, until: at(180).toISOString() },
      OPTIONS,
    );
    assert(outcome.ran);
    assertEquals(outcome.windows.length, 3);
    assertEquals(await readHourly(db), EXPECTED);
  },
);

etlTest(
  "etl: two runners, one winner — the loser steps aside",
  async (db, db2) => {
    // Deterministic contention: hold the job's lock, then try to run.
    const lock = await db.tryAdvisoryLock(`sisal:etl:${JOB_NAME}`, {
      table: LOCKS,
    });
    assert(lock.acquired);
    try {
      assertEquals(await run(db2, job, { ...OPTIONS, now: NOW }), {
        ran: false,
        reason: "locked",
      });
    } finally {
      await lock.release();
    }
    // Once released, the same runner proceeds.
    assert((await run(db2, job, { ...OPTIONS, now: NOW })).ran);
  },
);

etlTest("etl: a concurrent race never double-counts", async (db, db2) => {
  // Both connections drain concurrently; the lock serializes each window and
  // the grain-keyed upsert makes any interleave idempotent, so the final
  // state and checkpoint are exactly the single-runner result.
  const [a, b] = await Promise.all([catchUp(db), catchUp(db2)]);
  assertEquals(a + b >= 4, true, `expected ≥ 4 total folds, got ${a}+${b}`);
  assertEquals(await readHourly(db), EXPECTED);
  const report = await status(db, job, { ...OPTIONS, now: NOW });
  assertEquals(report.checkpoint?.windowEnd, NOW.toISOString());
});

etlTest("etl: replay behind the pruned horizon is refused", async (db) => {
  await catchUp(db);
  // Consolidated: raise the retention horizon past the first bucket (the
  // v0.9 substrate call; horizon-only — the source rows stay so the unsafe
  // override below can genuinely re-derive).
  const checkpoint = etlCheckpoint(db, JOB_NAME, { table: CHECKPOINTS });
  await checkpoint.prune(at(60).toISOString());

  const refusal = await assertRejects(
    () => replay(db, job, T0, OPTIONS),
    OrmError,
    "pruned_before",
  );
  assertEquals(refusal.code, "ORM_REPLAY_PRUNED");

  // The deliberate override re-derives from the (still present) source.
  const outcome = await replay(db, job, T0, {
    ...OPTIONS,
    unsafeAllowPrunedReplay: true,
  });
  assert(outcome.ran);
  assertEquals(await readHourly(db), EXPECTED);
});
