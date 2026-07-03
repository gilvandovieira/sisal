/**
 * Scheduling a Sisal ETL job with `Deno.cron` (PostgreSQL family).
 *
 * The v0.10 ETL model: **Sisal defines the job and what one run means; a
 * scheduler decides when.** This example is the in-process variant of the
 * [external-scheduler docs](../../docs/etl-scheduling.md) — a long-lived Deno
 * process (or a Deno Deploy deployment) uses `Deno.cron` to wake the runner
 * once an hour, and every wake-up drains all closed buckets with the
 * catch-up loop (`run()` folds ONE window per call).
 *
 * With zero setup this prints the exact pushed-down SQL the runner would
 * send (`explain`). With `DATABASE_URL` set it connects, creates the two
 * tables, seeds a few demo events, catches up immediately, and then
 * schedules the hourly `Deno.cron` job:
 *
 * ```sh
 * # just print the generated rollup SQL (no database):
 * deno run --allow-read examples/postgres-family-etl-cron/mod.ts
 * # connect, backlog-catch-up, then keep folding hourly via Deno.cron:
 * DATABASE_URL=postgres://... \
 *   deno run --unstable-cron --allow-env --allow-net --allow-read \
 *   examples/postgres-family-etl-cron/mod.ts
 * ```
 *
 * Safe under any trigger cadence: overlapping wake-ups are serialized by the
 * job's advisory lock, a missed tick is caught up by the next one, and
 * re-running a window upserts idempotently instead of double-counting.
 *
 * @module
 */

import {
  columns,
  count,
  createSchemaSnapshot,
  defineTable,
  eq,
  filter,
  primaryKey,
} from "@sisal/orm";
import { defineJob, explain, run, status, truncateToGrain } from "@sisal/etl";
import { connect, type PgDatabase } from "@sisal/pg";
import { generatePostgresUpStatements } from "@sisal/pg/ddl";

const postEvents = defineTable("post_events", {
  id: columns.bigserial().primaryKey(),
  post_id: columns.bigint().notNull(),
  kind: columns.text().notNull(),
  occurred_at: columns.timestamp({ withTimezone: true, mode: "date" })
    .notNull(),
});

const postHourlyStats = defineTable("post_hourly_stats", {
  post_id: columns.bigint().notNull(),
  bucket: columns.timestamp({ withTimezone: true, mode: "date" }).notNull(),
  views: columns.integer().notNull(),
  votes: columns.integer().notNull(),
  comments: columns.integer().notNull(),
}, (c) => [primaryKey({ columns: [c.post_id, c.bucket] })]);

const e = postEvents.columns;

// A fresh job needs a grain-aligned start; begin three (whole) hours ago so
// the seeded demo events below fall inside the first windows.
const start = truncateToGrain(
  new Date(Date.now() - 3 * 3_600_000),
  "hour",
).toISOString();

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
    votes: filter(count(), eq(e.kind, "vote")),
    comments: filter(count(), eq(e.kind, "comment")),
  },
  start,
});

// Zero-setup: the exact statement one run pushes down (dry-run, T20).
const sample = explain(job, {
  from: start,
  until: truncateToGrain(new Date(), "hour").toISOString(),
});
console.log(sample.text);
console.log(`-- params: ${JSON.stringify(sample.params)}\n`);

/** Folds every closed bucket — `run()` does ONE window per call. */
async function catchUp(db: PgDatabase): Promise<void> {
  while (true) {
    const outcome = await run(db, job);
    if (!outcome.ran) {
      console.log(`[etl] ${outcome.reason}`);
      return;
    }
    console.log(
      `[etl] folded [${outcome.window.from}, ${outcome.window.until})`,
    );
  }
}

const url = readEnv("DATABASE_URL");
if (url === undefined) {
  console.log(
    "Set DATABASE_URL to run the job on a schedule with Deno.cron.",
  );
} else {
  const db = await connect({ url });

  // Create the source/target tables (additive DDL) and seed demo events.
  const snapshot = createSchemaSnapshot({
    dialect: "postgres",
    tables: [postEvents, postHourlyStats],
  });
  for (const statement of generatePostgresUpStatements(snapshot).statements) {
    await db.execute(statement);
  }
  await seedDemoEvents(db);

  // Drain the backlog once at startup, then let Deno.cron keep the rollup
  // current: minute 5 of every hour, right after each bucket closes.
  await catchUp(db);
  Deno.cron("post-hourly-stats rollup", "5 * * * *", async () => {
    await catchUp(db);
    const report = await status(db, job);
    console.log(
      `[etl] checkpoint at ${report.checkpoint?.windowEnd ?? "(fresh)"}`,
    );
  });
  console.log("[etl] Deno.cron scheduled: '5 * * * *' — leave this running.");
}

/** A little traffic across the last three hours so the windows fold data. */
async function seedDemoEvents(db: PgDatabase): Promise<void> {
  const kinds = ["view", "view", "view", "vote", "comment"] as const;
  const now = Date.now();
  // pg-family bigint columns read back (and insert) as strings (v0.9 T7).
  const values = Array.from({ length: 30 }, (_, i) => ({
    post_id: String((i % 3) + 1),
    kind: kinds[i % kinds.length],
    occurred_at: new Date(now - (i % 18) * 600_000), // spread over ~3h
  }));
  await db.insert(postEvents).values(values).execute();
}

/** Reads an environment variable, tolerating a missing `--allow-env`. */
function readEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}
