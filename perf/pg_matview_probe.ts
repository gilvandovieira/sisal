/**
 * Materialized-view rollup probe (v0.10 CF2, investigate-first).
 *
 * Question: for the canonical `post_events → post_hourly_stats` shape, does a
 * `CREATE MATERIALIZED VIEW` + `REFRESH` path beat the `@sisal/etl`
 * generated-SQL rollup — and can it fit the runner model at all?
 *
 * The probe seeds N events across 24 hourly buckets on a real PostgreSQL
 * server, then times the operational paths at each scale:
 *
 * 1. **Incremental window fold** — the *exact* statement `run()` sends (the
 *    `rollup()` insert-from-select upsert for ONE hour window). This is the
 *    steady-state cost of the shipped model.
 * 2. **Full rollup rebuild** — the same generated statement over the whole
 *    range (what a complete `backfill` costs as a single statement).
 * 3. **`REFRESH MATERIALIZED VIEW`** — Postgres's only refresh: a full
 *    recompute that takes an ACCESS EXCLUSIVE lock (readers block).
 * 4. **`REFRESH MATERIALIZED VIEW CONCURRENTLY`** — full recompute + diff
 *    against the old snapshot (needs a unique index; readers keep working).
 *
 * Each timing is the median of `RUNS` (default 5). Findings feed the CF2
 * build-or-defer decision recorded in `perf/PG_MATVIEW_ROLLUP_PROBE.md`.
 *
 * ```sh
 * DATABASE_URL=postgres://postgres:postgres@localhost:55418/sisal \
 *   deno task perf:pg:matview            # scales: 100k, 1M events
 * PROBE_SCALES=50000 PROBE_RUNS=3 deno task perf:pg:matview
 * ```
 *
 * @module
 */

import { columns, count, defineTable, eq, filter } from "@sisal/orm";
import { defineJob, rollup } from "@sisal/etl";
import { renderSql } from "@sisal/core";
import { connect, type PgDatabase } from "@sisal/pg";

const URL = Deno.env.get("DATABASE_URL");
if (URL === undefined) {
  console.error("Set DATABASE_URL to a PostgreSQL server.");
  Deno.exit(1);
}

const SCALES = (Deno.env.get("PROBE_SCALES") ?? "100000,1000000")
  .split(",").map((n) => Number(n.trim()));
const RUNS = Number(Deno.env.get("PROBE_RUNS") ?? "5");

const T0 = "2026-01-01T00:00:00.000Z";
const HOURS = 24;

const postEvents = defineTable("cf2_events", {
  id: columns.bigserial().primaryKey(),
  post_id: columns.bigint().notNull(),
  kind: columns.text().notNull(),
  occurred_at: columns.timestamp({ withTimezone: true, mode: "date" })
    .notNull(),
});

const postHourlyStats = defineTable("cf2_hourly", {
  post_id: columns.bigint().notNull(),
  bucket: columns.timestamp({ withTimezone: true, mode: "date" }).notNull(),
  views: columns.integer().notNull(),
  votes: columns.integer().notNull(),
  comments: columns.integer().notNull(),
});

const e = postEvents.columns;

const job = defineJob({
  name: "cf2-hourly",
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

// The matview computes the SAME aggregate over ALL events — that is the model:
// a matview cannot be windowed/checkpointed, only recomputed.
const MATVIEW_SELECT = `select post_id,
    date_trunc('hour', occurred_at) as bucket,
    count(*) filter (where kind = 'view')    as views,
    count(*) filter (where kind = 'vote')    as votes,
    count(*) filter (where kind = 'comment') as comments
  from cf2_events group by post_id, date_trunc('hour', occurred_at)`;

function isoHour(offsetHours: number): string {
  return new Date(new Date(T0).getTime() + offsetHours * 3_600_000)
    .toISOString();
}

function windowStatement(fromHour: number, untilHour: number) {
  return renderSql(
    rollup(job, { from: isoHour(fromHour), until: isoHour(untilHour) }),
    { dialect: "postgres" },
  );
}

async function timeIt(fn: () => Promise<unknown>): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const started = performance.now();
    await fn();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

const ms = (value: number) => `${value.toFixed(1)} ms`;

async function probeScale(db: PgDatabase, events: number): Promise<void> {
  console.log(`\n=== ${events.toLocaleString("en-US")} events / ${HOURS}h ===`);

  await db.execute(`drop materialized view if exists cf2_hourly_mv`);
  await db.execute(`drop table if exists cf2_events`);
  await db.execute(`drop table if exists cf2_hourly`);
  await db.execute(
    `create table cf2_events (id bigserial primary key,
      post_id bigint not null, kind text not null,
      occurred_at timestamptz not null)`,
  );
  await db.execute(
    `create table cf2_hourly (post_id bigint not null,
      bucket timestamptz not null, views integer not null,
      votes integer not null, comments integer not null,
      primary key (post_id, bucket))`,
  );
  await db.execute(`create index on cf2_events (occurred_at)`);
  await db.execute(
    `insert into cf2_events (post_id, kind, occurred_at)
     select (g % 100) + 1,
       (array['view','view','view','vote','comment'])[(g % 5) + 1],
       timestamptz '${T0}' + (g % ${HOURS * 60}) * interval '1 minute'
     from generate_series(0, ${events - 1}) g`,
  );
  await db.execute(`analyze cf2_events`);

  // (1) steady state: fold ONE hour, repeatedly (idempotent upsert).
  const oneWindow = windowStatement(HOURS - 1, HOURS);
  const incremental = await timeIt(() =>
    db.execute(oneWindow.text, oneWindow.params)
  );

  // (2) full rebuild via the same generated statement over the whole range.
  const fullWindow = windowStatement(0, HOURS);
  const fullRebuild = await timeIt(() =>
    db.execute(fullWindow.text, fullWindow.params)
  );

  // (3) + (4) the matview paths (both are full recomputes by definition).
  await db.execute(
    `create materialized view cf2_hourly_mv as ${MATVIEW_SELECT}`,
  );
  await db.execute(
    `create unique index cf2_hourly_mv_key on cf2_hourly_mv (post_id, bucket)`,
  );
  const refresh = await timeIt(() =>
    db.execute(`refresh materialized view cf2_hourly_mv`)
  );
  const refreshConcurrently = await timeIt(() =>
    db.execute(`refresh materialized view concurrently cf2_hourly_mv`)
  );

  console.log(
    `incremental fold (1 window, the run() path):  ${ms(incremental)}`,
  );
  console.log(
    `full rollup rebuild (24 windows, 1 stmt):     ${ms(fullRebuild)}`,
  );
  console.log(`REFRESH MATERIALIZED VIEW (locks readers):    ${ms(refresh)}`);
  console.log(
    `REFRESH ... CONCURRENTLY (needs unique idx):  ${ms(refreshConcurrently)}`,
  );
  console.log(
    `matview refresh vs incremental fold: ${
      (refresh / incremental).toFixed(1)
    }× / concurrently ${(refreshConcurrently / incremental).toFixed(1)}×`,
  );
}

const db = await connect({ url: URL });
try {
  for (const scale of SCALES) {
    await probeScale(db, scale);
  }
  await db.execute(`drop materialized view if exists cf2_hourly_mv`);
  await db.execute(`drop table if exists cf2_events`);
  await db.execute(`drop table if exists cf2_hourly`);
} finally {
  await db.close();
}
