/**
 * ETL **limits and failure-recovery** battery for `@sisal/etl` (v0.10 T23
 * extension) — deliberately NOT the happy path. Each scenario breaks
 * something a real deployment breaks (schema drift, hand-edited checkpoints,
 * late data, wrong clocks, crashed lock holders, pruned sources) and pins
 * both the failure shape (typed error / typed non-run outcome / stale state)
 * and the recovery path. The observed behaviors are catalogued in
 * [docs/etl-pain-points.md](../docs/etl-pain-points.md).
 *
 * Gated on `DATABASE_URL` (skipped when unset). Run:
 *
 *   DATABASE_URL=postgres://postgres:postgres@localhost:55418/sisal \
 *     deno test --allow-net --allow-env --allow-read \
 *     integration/etl_limits_test.ts
 *
 * @module
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  columns,
  count,
  countDistinct,
  defineTable,
  eq,
  etlCheckpoint,
  filter,
  lt,
  OrmError,
  sql,
} from "@sisal/orm";
import { defineJob, replay, run, status } from "@sisal/etl";
import { connect, type PgDatabase } from "@sisal/pg";
import { env } from "./_shared/env.ts";

const URL = env("DATABASE_URL");
const SKIP = URL === undefined;

const EVENTS = "it_lim_events";
const HOURLY = "it_lim_hourly";
const GLOBAL = "it_lim_global";
const CHECKPOINTS = "it_lim_checkpoints";
const LOCKS = "it_lim_locks";

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

/** Global (no group keys) rollup target — bucket is the whole upsert key. */
const globalStats = defineTable(GLOBAL, {
  bucket: columns.timestamp({ withTimezone: true, mode: "date" }).notNull(),
  events: columns.integer().notNull(),
  active_posts: columns.integer().notNull(),
  score: columns.doublePrecision().notNull(),
});

const e = postEvents.columns;

const T0 = "2026-01-01T00:00:00.000Z";
const at = (offsetMinutes: number): Date =>
  new Date(new Date(T0).getTime() + offsetMinutes * 60_000);
const NOW = at(4 * 60);

function hourlyJob(name: string) {
  return defineJob({
    name,
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
}

const job = hourlyJob("it-lim-hourly");
const OPTIONS = { checkpointTable: CHECKPOINTS, lock: { table: LOCKS } };

interface HourlyRow {
  readonly post_id: string;
  readonly bucket: string;
  readonly views: number;
  readonly votes: number;
  readonly comments: number;
}

async function reset(
  db: PgDatabase,
  options: { pk?: boolean } = {},
): Promise<void> {
  for (const table of [EVENTS, HOURLY, GLOBAL, CHECKPOINTS, LOCKS]) {
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
      `votes integer not null, comments integer not null` +
      (options.pk === false
        ? ")"
        : `, constraint it_lim_hourly_pk primary key (post_id, bucket))`),
  );
  await db.execute(
    `create table ${GLOBAL} (bucket timestamptz primary key, ` +
      `events integer not null, active_posts integer not null, ` +
      `score double precision not null)`,
  );
}

/** Deterministic hour-0 traffic: p1 → 2 views + 1 vote; p2 → 1 comment. */
async function seedHourZero(db: PgDatabase): Promise<void> {
  await db.insert(postEvents).values([
    { post_id: "1", kind: "view", occurred_at: at(10) },
    { post_id: "1", kind: "view", occurred_at: at(20) },
    { post_id: "1", kind: "vote", occurred_at: at(30) },
    { post_id: "2", kind: "comment", occurred_at: at(40) },
  ]).execute();
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

async function catchUp(db: PgDatabase, now = NOW): Promise<number> {
  let folded = 0;
  while ((await run(db, job, { ...OPTIONS, now })).ran) folded += 1;
  return folded;
}

async function watermark(db: PgDatabase): Promise<string | null> {
  return (await status(db, job, { ...OPTIONS, now: NOW })).checkpoint
    ?.windowEnd ?? null;
}

function limTest(
  name: string,
  fn: (db: PgDatabase, db2: PgDatabase) => Promise<void>,
  options: { pk?: boolean } = {},
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
        await reset(db, options);
        await fn(db, db2);
      } finally {
        await db2.close();
        await db.close();
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Failure & recovery
// ---------------------------------------------------------------------------

limTest(
  "fail: missing upsert key — run fails, checkpoint intact, fix + rerun recovers",
  async (db) => {
    // PAIN POINT 1: nothing validates at definition time that the target has
    // a unique constraint matching (bucket + group keys); the failure is a
    // live ON CONFLICT error on the FIRST run.
    await seedHourZero(db);
    await assertRejects(
      () => run(db, job, { ...OPTIONS, now: NOW }),
      OrmError,
      // PostgreSQL: "no unique or exclusion constraint matching the ON
      // CONFLICT specification" — surfaced as a typed OrmError.
    );
    // The atomic batch rolled back: no watermark, no partial rows.
    assertEquals(await watermark(db), null);
    assertEquals(await readHourly(db), []);

    // RECOVERY: add the key and simply run again — same window, clean fold.
    await db.execute(
      `alter table ${HOURLY} add constraint it_lim_hourly_pk ` +
        `primary key (post_id, bucket)`,
    );
    const outcome = await run(db, job, { ...OPTIONS, now: NOW });
    assert(outcome.ran);
    assertEquals((await readHourly(db)).length, 2);
  },
  { pk: false },
);

limTest(
  "fail: schema drift mid-life — typed error, resume after restore",
  async (db) => {
    await seedHourZero(db);
    assert((await run(db, job, { ...OPTIONS, now: NOW })).ran);
    const before = await watermark(db);

    // The target loses a column between runs (drift the migrator never saw).
    await db.execute(`alter table ${HOURLY} drop column comments`);
    await assertRejects(() => run(db, job, { ...OPTIONS, now: NOW }), OrmError);
    // The failed window did not advance the watermark.
    assertEquals(await watermark(db), before);

    // RECOVERY: restore the column; the runner resumes at the failed window.
    await db.execute(
      `alter table ${HOURLY} add column comments integer not null default 0`,
    );
    const resumed = await run(db, job, { ...OPTIONS, now: NOW });
    assert(resumed.ran);
    assertEquals(resumed.window.from, before);
  },
);

limTest(
  "fail: hand-advanced unaligned watermark — whole bucket refolds, no undercount",
  async (db) => {
    await seedHourZero(db);
    assert((await run(db, job, { ...OPTIONS, now: NOW })).ran);
    const folded = await readHourly(db);

    // PAIN POINT 2: advance() accepts ANY marker — an operator can park the
    // watermark mid-bucket. The runner must not trust it blindly: a window
    // resuming at 00:30 would recount hour 0 from only the tail rows and
    // OVERWRITE the full counts with an undercount.
    const checkpoint = etlCheckpoint(db, job.name, { table: CHECKPOINTS });
    await checkpoint.advance(at(30).toISOString());

    const refold = await run(db, job, { ...OPTIONS, now: NOW });
    assert(refold.ran);
    // The window floored to the bucket edge and refolded ALL of hour 0.
    assertEquals(refold.window, {
      from: T0,
      until: at(60).toISOString(),
    });
    assertEquals(await readHourly(db), folded);
  },
);

limTest(
  "fail: watermark rewound to the beginning — idempotent refold converges",
  async (db) => {
    await seedHourZero(db);
    assertEquals(await catchUp(db), 4);
    const settled = await readHourly(db);

    // An operator rewinds the checkpoint to reprocess everything.
    const checkpoint = etlCheckpoint(db, job.name, { table: CHECKPOINTS });
    await checkpoint.advance(T0);

    // RECOVERY is just running: every window refolds idempotently.
    assertEquals(await catchUp(db), 4);
    assertEquals(await readHourly(db), settled);
    assertEquals(await watermark(db), NOW.toISOString());
  },
);

limTest(
  "fail: late-arriving events land behind the watermark — replay recovers",
  async (db) => {
    await seedHourZero(db);
    assertEquals(await catchUp(db), 4);

    // PAIN POINT 3: an event written into an already-folded bucket is
    // invisible to run() — the watermark has passed it, so the target is
    // silently stale.
    await db.insert(postEvents).values([
      { post_id: "1", kind: "view", occurred_at: at(15) },
    ]).execute();
    assertEquals(await run(db, job, { ...OPTIONS, now: NOW }), {
      ran: false,
      reason: "up-to-date",
    });
    const stale = await readHourly(db);
    assertEquals(stale[0].views, 2); // still the pre-late-event count

    // RECOVERY: replay the affected window (the operator must know or find
    // which bucket the late rows hit).
    assert((await replay(db, job, T0, OPTIONS)).ran);
    assertEquals((await readHourly(db))[0].views, 3);
  },
);

limTest(
  "fail: clock behind the watermark — job parks as up-to-date, status shows it",
  async (db) => {
    await seedHourZero(db);
    assertEquals(await catchUp(db), 4);

    // PAIN POINT 4: if the runner's clock is behind the checkpoint (skew, or
    // a watermark advanced from a machine with a fast clock), run() reports
    // plain "up-to-date" forever — indistinguishable from genuinely being
    // current. status() is the observability hook: next === null while
    // updatedAt stops moving.
    const skewed = await run(db, job, { ...OPTIONS, now: at(60) });
    assertEquals(skewed, { ran: false, reason: "up-to-date" });
    const report = await status(db, job, { ...OPTIONS, now: at(60) });
    assertEquals(report.next, null);
    assertEquals(report.checkpoint?.windowEnd, NOW.toISOString());
  },
);

limTest(
  "fail: crashed lock holder — the lease expires and the next runner self-heals",
  async (db, db2) => {
    await seedHourZero(db);

    // A runner "crashes" holding the lock: acquired, never released. With a
    // short TTL the lease expires; the next claimant reaps it and proceeds.
    const crashed = await db.tryAdvisoryLock(`sisal:etl:${job.name}`, {
      table: LOCKS,
      ttlMs: 100,
    });
    assert(crashed.acquired);

    // While the lease is live, the second runner steps aside...
    assertEquals(await run(db2, job, { ...OPTIONS, now: NOW }), {
      ran: false,
      reason: "locked",
    });
    // ...and after expiry it recovers WITHOUT any operator action.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const outcome = await run(db2, job, { ...OPTIONS, now: NOW });
    assert(outcome.ran);

    // PAIN POINT 5: the lease is time-based — a runner that is alive but
    // slower than its TTL can be raced by a second claimant. The default TTL
    // is 30 s; a long-running window fold must raise options.lock.ttlMs.
    await crashed.release(); // releases only its own (already reaped) row
  },
);

limTest(
  "fail: source rows pruned — unsafe replay CANNOT zero a bucket (add/overwrite only)",
  async (db) => {
    await seedHourZero(db);
    assertEquals(await catchUp(db), 4);
    const settled = await readHourly(db);

    // Consolidate + prune hour 0 for real: horizon up AND source rows gone,
    // atomically (the substrate call the retention story prescribes).
    const checkpoint = etlCheckpoint(db, job.name, { table: CHECKPOINTS });
    await checkpoint.prune(at(60).toISOString(), [
      db.delete(postEvents).where(lt(e.occurred_at, at(60))),
    ]);

    // The guard refuses the pruned window...
    const refusal = await assertRejects(
      () => replay(db, job, T0, OPTIONS),
      OrmError,
    );
    assertEquals(refusal.code, "ORM_REPLAY_PRUNED");

    // PAIN POINT 6: the unsafe override "succeeds" — but the rollup is
    // insert-from-select: with zero source rows it upserts NOTHING. The old
    // counts survive untouched; replay can never zero or shrink a bucket.
    const overridden = await replay(db, job, T0, {
      ...OPTIONS,
      unsafeAllowPrunedReplay: true,
    });
    assert(overridden.ran);
    assertEquals(await readHourly(db), settled); // unchanged, NOT zeroed

    // RECOVERY from a truly bad bucket: restore the source rows, delete the
    // target rows for the window, then replay re-derives them.
    await seedHourZero(db);
    await db.execute(
      `delete from ${HOURLY} where bucket = timestamptz '${T0}'`,
    );
    assert(
      (await replay(db, job, T0, { ...OPTIONS, unsafeAllowPrunedReplay: true }))
        .ran,
    );
    assertEquals(await readHourly(db), settled);
  },
);

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

limTest(
  "limit: 50k events / 25 hourly windows — pushdown totals reconcile exactly",
  async (db) => {
    // Bulk-seed server-side; no rows round-trip through the runner either
    // way, so the only limit is the database's own GROUP BY.
    await db.execute(
      `insert into ${EVENTS} (post_id, kind, occurred_at) ` +
        `select (g % 20) + 1, ` +
        `(array['view','view','view','vote','comment'])[(g % 5) + 1], ` +
        `timestamptz '${T0}' + (g % 1440) * interval '1 minute' ` +
        `from generate_series(0, 49999) g`,
    );
    assertEquals(await catchUp(db, at(25 * 60)), 25);

    const totals = await db.query<
      { views: string; votes: string; comments: string }
    >(
      sql`select sum(views)::text as views, sum(votes)::text as votes,
          sum(comments)::text as comments from it_lim_hourly`,
    );
    assertEquals(totals.rows[0], {
      views: "30000",
      votes: "10000",
      comments: "10000",
    });
  },
);

limTest(
  "limit: global rollup (no group keys) + composite aggregates + shared system tables",
  async (db) => {
    // Two different jobs multiplex the SAME checkpoint and lock tables —
    // rows are keyed by job/lock name, so they must not interfere.
    await seedHourZero(db);
    assertEquals(await catchUp(db), 4);

    const globalJob = defineJob({
      name: "it-lim-global",
      source: postEvents,
      target: globalStats,
      window: e.occurred_at,
      grain: "hour",
      bucket: "bucket",
      aggregates: {
        events: count(),
        active_posts: countDistinct(e.post_id),
        score: sql`${filter(count(), eq(e.kind, "vote"))} * 2.0 + ${
          filter(count(), eq(e.kind, "comment"))
        } * 3.0`,
      },
      start: T0,
    });
    let folded = 0;
    while ((await run(db, globalJob, { ...OPTIONS, now: NOW })).ran) folded++;
    assertEquals(folded, 4);

    const g = globalStats.columns;
    const rows = await db.select({
      events: g.events,
      active_posts: g.active_posts,
      score: g.score,
    }).from(globalStats).where(eq(g.bucket, new Date(T0))).execute();
    assertEquals(rows, [{ events: 4, active_posts: 2, score: 5 }]);

    // Both jobs kept independent checkpoints in the shared table.
    assertEquals(await watermark(db), NOW.toISOString());
    const globalReport = await status(db, globalJob, {
      ...OPTIONS,
      now: NOW,
    });
    assertEquals(globalReport.checkpoint?.windowEnd, NOW.toISOString());
  },
);

limTest(
  "limit: events exactly on a bucket edge land in exactly one window",
  async (db) => {
    await db.insert(postEvents).values([
      { post_id: "1", kind: "view", occurred_at: at(0) }, // == from of h0
      { post_id: "1", kind: "view", occurred_at: at(60) }, // == until of h0
    ]).execute();
    assertEquals(await catchUp(db), 4);
    const rows = await readHourly(db);
    // Half-open [from, until): the 01:00:00.000 event belongs ONLY to hour 1.
    assertEquals(rows, [
      { bucket: T0, post_id: "1", views: 1, votes: 0, comments: 0 },
      {
        bucket: at(60).toISOString(),
        post_id: "1",
        views: 1,
        votes: 0,
        comments: 0,
      },
    ]);
  },
);

limTest(
  "limit: month grain — runner edges agree with date_trunc across calendar lengths",
  async (db) => {
    const monthly = defineTable("it_lim_monthly", {
      post_id: columns.bigint().notNull(),
      bucket: columns.timestamp({ withTimezone: true, mode: "date" })
        .notNull(),
      views: columns.integer().notNull(),
    });
    await db.execute(`drop table if exists it_lim_monthly`);
    await db.execute(
      `create table it_lim_monthly (post_id bigint not null, ` +
        `bucket timestamptz not null, views integer not null, ` +
        `primary key (post_id, bucket))`,
    );
    const monthlyJob = defineJob({
      name: "it-lim-monthly",
      source: postEvents,
      target: monthly,
      window: e.occurred_at,
      grain: "month",
      bucket: "bucket",
      groupBy: { post_id: e.post_id },
      aggregates: { views: filter(count(), eq(e.kind, "view")) },
      start: T0,
    });
    // One view on Jan 31 23:59:59.999 and one on Feb 1 00:00:00.000 — the
    // calendar boundary the runner and date_trunc must agree on exactly.
    await db.insert(postEvents).values([
      {
        post_id: "1",
        kind: "view",
        occurred_at: new Date("2026-01-31T23:59:59.999Z"),
      },
      {
        post_id: "1",
        kind: "view",
        occurred_at: new Date("2026-02-01T00:00:00.000Z"),
      },
    ]).execute();
    let folded = 0;
    while (
      (await run(db, monthlyJob, {
        ...OPTIONS,
        now: new Date("2026-03-01T00:00:00Z"),
      })).ran
    ) folded++;
    assertEquals(folded, 2); // January + February

    const m = monthly.columns;
    const rows = await db.select({ bucket: m.bucket, views: m.views })
      .from(monthly).execute();
    assertEquals(
      rows.map((r) => ({
        bucket: new Date(r.bucket as unknown as string).toISOString(),
        views: r.views,
      })).sort((a, b) => a.bucket.localeCompare(b.bucket)),
      [
        { bucket: "2026-01-01T00:00:00.000Z", views: 1 },
        { bucket: "2026-02-01T00:00:00.000Z", views: 1 },
      ],
    );
    await db.execute(`drop table if exists it_lim_monthly`);
  },
);

limTest(
  "limit: 200-char job name fits the checkpoint and lock caps",
  async (db) => {
    const longJob = hourlyJob("j".repeat(200));
    await seedHourZero(db);
    const outcome = await run(db, longJob, { ...OPTIONS, now: NOW });
    assert(outcome.ran);
    const report = await status(db, longJob, { ...OPTIONS, now: NOW });
    assertEquals(report.checkpoint?.windowEnd, at(60).toISOString());
  },
);

limTest(
  "limit: bigint group keys beyond 2^53 round-trip exactly (string identity)",
  async (db) => {
    const huge = "9007199254740995"; // 2^53 + 3 — unrepresentable as a JS number
    await db.insert(postEvents).values([
      { post_id: huge, kind: "view", occurred_at: at(10) },
    ]).execute();
    assert((await run(db, job, { ...OPTIONS, now: NOW })).ran);
    const rows = await readHourly(db);
    assertEquals(rows, [
      { bucket: T0, post_id: huge, views: 1, votes: 0, comments: 0 },
    ]);
  },
);

limTest(
  "limit: minute grain — 90 windows catch up in one drain",
  async (db) => {
    await db.execute(
      `insert into ${EVENTS} (post_id, kind, occurred_at) ` +
        `select 1, 'view', timestamptz '${T0}' + g * interval '1 minute' ` +
        `from generate_series(0, 89) g`,
    );
    const minuteTarget = defineTable("it_lim_minutely", {
      bucket: columns.timestamp({ withTimezone: true, mode: "date" })
        .notNull(),
      views: columns.integer().notNull(),
    });
    await db.execute(`drop table if exists it_lim_minutely`);
    await db.execute(
      `create table it_lim_minutely (bucket timestamptz primary key, ` +
        `views integer not null)`,
    );
    const minuteJob = defineJob({
      name: "it-lim-minutely",
      source: postEvents,
      target: minuteTarget,
      window: e.occurred_at,
      grain: "minute",
      bucket: "bucket",
      aggregates: { views: filter(count(), eq(e.kind, "view")) },
      start: T0,
    });
    let folded = 0;
    while (
      (await run(db, minuteJob, { ...OPTIONS, now: at(90) })).ran
    ) folded++;
    assertEquals(folded, 90);
    const total = await db.query<{ n: string }>(
      sql`select count(*)::text as n from it_lim_minutely where views = 1`,
    );
    assertEquals(total.rows[0].n, "90");
    await db.execute(`drop table if exists it_lim_minutely`);
  },
);
