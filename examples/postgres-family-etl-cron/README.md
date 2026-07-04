# PostgreSQL-family ETL cron

## What this example teaches

`@sisal/etl` — the typed rollup job model and its single-window runner, driven
by `Deno.cron`. The rule: **Sisal defines the job and what one run means; a
scheduler decides when.** It shows:

- `defineJob(...)` — source, target, grain, window column, group keys, and
  aggregate expressions, validated at definition time;
- `explain(job, window)` — the exact pushed-down `INSERT … SELECT … ON CONFLICT`
  rollup SQL, rendered without executing (the zero-setup dry-run);
- `run(db, job)` — fold **one** closed window per call, behind an advisory lock,
  with an atomic checkpoint/watermark advance;
- a catch-up loop that drains the backlog, then `Deno.cron` to keep it current;
- `status(db, job)` — the read-only checkpoint / next-window report.

It folds raw `post_events` into an hourly `post_hourly_stats` rollup — `views`,
`votes`, `comments`, and a weighted `engagement_score`, grouped by
`(post_id, community_id, bucket)`.

## Packages used

`@sisal/etl`, `@sisal/orm` (schema), `@sisal/pg` (+ `@sisal/pg/ddl`).

## Dialect target

PostgreSQL. The rollup uses `count(*) FILTER (…)` and `date_trunc`, and the
runner uses the advisory-lock + checkpoint substrate.

## What is portable

The job model and generated rollup are dialect-neutral; `@sisal/etl` gates
unsupported engines with `supportsJob` / `assertJobSupported`.

## What is dialect-specific

The `FILTER` aggregate and idempotent `ON CONFLICT DO UPDATE` upsert are
rendered per dialect (MySQL uses `CASE` + `ON DUPLICATE KEY UPDATE`); this
example targets Postgres.

## How to run

```sh
# just print the generated rollup SQL (no database):
deno task run          # == deno run --allow-read mod.ts

# connect, backlog-catch-up, then keep folding hourly via Deno.cron:
DATABASE_URL=postgres://postgres:postgres@localhost:5432/scratch \
  deno task cron       # == deno run --unstable-cron --allow-env --allow-net --allow-read mod.ts
```

Environment variables:

```
DATABASE_URL=      # optional for the dry-run; required for the live cron
```

## Expected output

Without a database it prints the generated
`INSERT INTO "post_hourly_stats" …
ON CONFLICT … DO UPDATE` statement plus its
parameters, then a hint. With `DATABASE_URL` it creates the tables, seeds demo
events, logs each folded window, and schedules the hourly cron.

## Notes

The rollup this job writes is exactly what
[`postgres-family-analytics`](../postgres-family-analytics/README.md) reads —
`post_events` → `post_hourly_stats`, then `@sisal/analytics` queries the rollup
(`bucket`, `movingAvg`, `rank`, `compareToPreviousWindow`). Read the two
examples together: **ETL builds the rollups; analytics reads them.**

Safe under any cadence: overlapping wake-ups serialize on the job's advisory
lock, a missed tick is caught up by the next one, and re-running a window
upserts idempotently instead of double-counting. See
[docs/etl-scheduling.md](../../docs/etl-scheduling.md) for the
external-scheduler variant.
