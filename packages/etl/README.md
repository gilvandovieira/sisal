# @sisal/etl

SQL-pushdown ETL for [Sisal](https://jsr.io/@sisal) preview packages: define a
lightweight rollup job in TypeScript and execute **one** safe, idempotent window
per invocation. The database does the heavy lifting — the runner sends a single
generated `INSERT ... SELECT ... ON CONFLICT DO UPDATE` statement; no row ever
round-trips through the process.

```ts
import { defineJob, run } from "@sisal/etl";
import { count, eq, filter, sum } from "@sisal/core";

const job = defineJob({
  name: "post-hourly-stats",
  source: postEvents,
  target: postHourlyStats,
  window: postEvents.columns.occurred_at,
  grain: "hour",
  bucket: "bucket",
  groupBy: { post_id: postEvents.columns.post_id },
  aggregates: {
    views: filter(count(), eq(postEvents.columns.kind, "view")),
    score: sum(postEvents.columns.score),
  },
  start: "2026-01-01T00:00:00.000Z",
});

// One window per call — an external cron/systemd-timer/CI job decides when.
const outcome = await run(db, job);
```

Each `run`:

1. acquires the job's portable advisory lock (concurrent runners are serialized
   — the loser exits with `{ ran: false, reason: "locked" }`);
2. reads the job's checkpoint and computes the next half-open window
   `[from, until)`, one grain wide, aligned to UTC bucket edges, never past
   `now`;
3. sends the generated rollup and advances the watermark **atomically** (one
   `db.batch`), so a crash never advances the checkpoint past data that was not
   written, and a re-run of a window overwrites instead of double-counts.

Around the runner:

- `backfill(db, job, range)` re-runs an explicit grain-aligned historical range
  as successive windows — deterministic, no wall-clock dependence, never
  advancing the checkpoint;
- `replay(db, job, from)` re-runs one window idempotently; both refuse windows
  behind the job's `pruned_before` retention horizon (`ORM_REPLAY_PRUNED`)
  unless the loud `unsafeAllowPrunedReplay` override acknowledges a restored
  source;
- `status(db, job)` reports the checkpoint, retention horizon, and the window
  the next run would fold — read-only, lock-free;
- `explain(job, window, { dialect })` is the dry-run: the exact generated SQL
  and bound parameters, without executing (retention pruning itself stays a
  substrate call — `etlCheckpoint(db, job.name).prune(...)` from `@sisal/orm`);
- `supportsJob(job, db.dialectIdentity)` / `assertJobSupported(...)` gate a
  job's shape per engine — an unsupported shape is a typed `ETL_UNSUPPORTED_JOB`
  refusal applied pre-flight by every runner entry point, never a
  silently-degraded run.

Deliberately **not** a scheduler, worker queue, full ETL transformation engine,
or data warehouse loader. Use it to test the waters for rollups and lightweight
database-native transforms; do not treat it as the de facto solution for complex
multi-stage ETL. An external trigger (cron, systemd timer, GitHub Actions,
`Deno.cron`) decides _when_; see
[docs/etl-scheduling.md](../../docs/etl-scheduling.md) and the runnable
[`examples/postgres-family-etl-cron`](../../examples/postgres-family-etl-cron/mod.ts).

The job model and SQL compilation depend on `@sisal/core` only; the runner
consumes the checkpoint/advisory-lock substrate from `@sisal/orm`. Execution
happens through whatever `Database` you inject — PostgreSQL first-class via
`@sisal/pg` or `@sisal/neon`; see `docs/feature-matrix.md` for other engines.

Know the sharp edges before deploying:
[docs/etl-pain-points.md](../../docs/etl-pain-points.md) catalogues the observed
failure modes (late-arriving events, lease expiry, pruned sources, schema drift,
hand-edited watermarks) and their recovery paths, each pinned by the live
failure battery in `integration/etl_limits_test.ts`.
