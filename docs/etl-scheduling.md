---
title: ETL scheduling
---

# Scheduling Sisal ETL jobs

Sisal ETL is deliberately **not** a scheduler
([v0.10 non-goals](v0.10.0-roadmap.md#non-goals)). The division of labor:

```
external scheduler (cron / systemd timer / CI / Deno.cron)   ← decides WHEN
  → the Sisal runner: run(db, job)                           ← decides WHAT ONE RUN MEANS
      → lock → checkpoint → next window → pushed-down SQL → atomic advance
```

`run(db, job)` folds **one** closed window and exits. That contract is what
makes any trigger safe:

- **Overlaps are serialized.** Two wake-ups racing on the same job contend on
  the advisory lock (`sisal:etl:<name>`); the loser returns
  `{ ran: false, reason: "locked" }` and exits. No corruption, no double-fold.
- **Misfires are caught up.** The checkpoint remembers where the job stopped; a
  missed tick just means the next one has more windows to fold.
- **Re-runs are idempotent.** The rollup upserts on the grain key, so a window
  folded twice overwrites rather than double-counts.
- **Early fires are no-ops.** A wake-up before the next bucket closes returns
  `{ ran: false, reason: "up-to-date" }`.

## The runner script and the catch-up loop

Every scheduler below invokes the same thing — a small script that drains all
closed buckets (`run()` does one window per call, so loop until it steps aside):

```ts
// etl_run.ts
import { connect } from "@sisal/pg";
import { run } from "@sisal/etl";
import { job } from "./job.ts"; // your defineJob(...)

const db = await connect({ url: Deno.env.get("DATABASE_URL")! });
try {
  while (true) {
    const outcome = await run(db, job);
    if (!outcome.ran) break; // "up-to-date" or "locked"
    console.log(`folded [${outcome.window.from}, ${outcome.window.until})`);
  }
} finally {
  await db.close();
}
```

Schedule it a few minutes **after** the bucket edge (e.g. minute 5 for an `hour`
grain) so late-arriving rows near the edge are already committed when the window
folds.

## cron / crontab

```cron
# m h dom mon dow  command
5 * * * *  cd /srv/app && DATABASE_URL=postgres://… \
  deno run --allow-env --allow-net --allow-read etl_run.ts >> /var/log/etl.log 2>&1
```

## systemd timer

`/etc/systemd/system/sisal-etl.service`:

```ini
[Unit]
Description=Sisal ETL hourly rollup (one catch-up run)

[Service]
Type=oneshot
WorkingDirectory=/srv/app
Environment=DATABASE_URL=postgres://…
ExecStart=/usr/bin/deno run --allow-env --allow-net --allow-read etl_run.ts
```

`/etc/systemd/system/sisal-etl.timer`:

```ini
[Unit]
Description=Run the Sisal ETL rollup hourly

[Timer]
OnCalendar=*-*-* *:05:00
Persistent=true

[Install]
WantedBy=timers.target
```

`Persistent=true` fires a missed tick at boot — and the catch-up loop folds
however many buckets accumulated while the machine was down.

## GitHub Actions

```yaml
name: etl-hourly-rollup
on:
  schedule:
    - cron: "5 * * * *"
  workflow_dispatch: {} # manual catch-up/backfill trigger

jobs:
  rollup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x
      - run: deno run --allow-env --allow-net --allow-read etl_run.ts
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
```

GitHub schedules are best-effort (ticks can be delayed or skipped under load) —
which is exactly why the checkpoint model assumes nothing about the trigger's
punctuality.

## Deno.cron (in-process / Deno Deploy)

For a long-lived Deno process — or a Deno Deploy deployment, where `Deno.cron`
is managed — the scheduler can live in the same process as the runner:

```ts
Deno.cron("post-hourly-stats rollup", "5 * * * *", async () => {
  while ((await run(db, job)).ran) { /* drain closed buckets */ }
});
```

On the CLI this needs the `--unstable-cron` flag. The runnable version — schema,
seeded events, immediate backlog catch-up, then the hourly `Deno.cron` — lives
at
[`examples/postgres-family-etl-cron`](../examples/postgres-family-etl-cron/mod.ts):

```sh
# print the generated rollup SQL (no database):
deno run --allow-read examples/postgres-family-etl-cron/mod.ts
# connect, catch up, and keep folding hourly:
DATABASE_URL=postgres://... \
  deno run --unstable-cron --allow-env --allow-net --allow-read \
  examples/postgres-family-etl-cron/mod.ts
```

Even in-process, the model is unchanged: `Deno.cron` decides _when_, `run()`
decides _what one run means_ — and the advisory lock still serializes against
any _other_ runner (a second deployment, an operator's manual catch-up).

## pg_cron — optional, never the only path

PostgreSQL's `pg_cron` extension runs SQL _inside_ the database, so it cannot
invoke the TypeScript runner — and with it you give up the runner's
checkpoint/lock/window machinery. What it _can_ do is re-fold a **fixed, known**
window with the exact statement `explain(job, window)` prints (the window bounds
are the two trailing parameters):

```sql
select cron.schedule('refold-latest-hour', '5 * * * *',
  $$ insert into post_hourly_stats (...) select ... $$);
```

Treat that as an acceleration for one pinned window, not as the scheduler:
`pg_cron` is Postgres-only, and per the
[v0.10 model](v0.10.0-roadmap.md#the-execution-model-the-whole-v010-runtime) it
**must never be the only path** — the external-scheduler + runner model above is
the default on every engine.

## Operational notes

- **One schedule per job.** The lock serializes concurrent runners, but the
  intended shape is a single trigger per job; parallelism across _jobs_ is free
  (each has its own lock and checkpoint).
- **Backfills are manual, not scheduled.** `backfill(db, job, range)` re-derives
  an explicit historical range deterministically; run it from an operator's
  shell or a one-off CI dispatch, not a recurring trigger.
- **Observability.** `status(db, job)` is read-only and lock-free — point
  dashboards and health checks at it; an `updatedAt` that stops advancing means
  the scheduler stopped firing.
- **Retention.** Prune consolidated source rows with the checkpoint substrate
  (`etlCheckpoint(db, job.name).prune(before, [deletes])` from `@sisal/orm`);
  `replay`/`backfill` refuse windows behind the horizon it records.
