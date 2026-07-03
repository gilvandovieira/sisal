---
title: ETL pain points
---

# ETL pain points — observed failure modes and recovery paths

What actually happens when a `@sisal/etl` (v0.10 preview) deployment breaks.
Every entry is pinned by a live-PostgreSQL scenario in
[`integration/etl_limits_test.ts`](../integration/etl_limits_test.ts) (run
alongside the acceptance suite `integration/etl_features_test.ts`) — this list
records **observed behavior**, not intent. Each has the failure, what the API
does today, the recovery, and where relevant a candidate follow-up for a later
release.

## 1. The upsert key is not validated at definition time

**Failure.** `defineJob` checks column coverage, but nothing verifies the target
table has a unique constraint matching `(bucket, ...groupBy)`. The mismatch only
surfaces on the **first live run**, as the database's `ON CONFLICT` error (a
typed `OrmError`, but a runtime one).

**Today.** The atomic batch rolls back cleanly: no watermark advance, no partial
rows (verified — this is the crash-atomicity invariant doing its job).

**Recovery.** Add the constraint and simply run again — the runner resumes at
the same window. _Test:
`fail: missing upsert key — run fails, checkpoint intact, fix + rerun
recovers`._

**Follow-up candidate.** A definition- or preflight-time check against the
schema snapshot (the target's `primaryKey`/`unique` extras are already
inspectable) could turn this into an `ETL_INVALID_JOB` before any SQL runs.

## 2. `advance()` accepts any marker — including unaligned and backward ones

**Failure.** The checkpoint substrate treats watermarks as opaque; an operator
(or a buggy script) can park the watermark mid-bucket or rewind it.

**Today.** Both are absorbed safely: an **unaligned** watermark makes the next
window floor to its bucket edge and refold the _whole_ bucket (never a partial
tail — a mid-bucket window would overwrite full counts with an undercount, which
is exactly what the v0.10 window math was fixed to prevent); a **rewound**
watermark just refolds forward idempotently until it reconverges.

**Recovery.** None needed beyond running — but the refold consumes one run per
grain step, so rewinding a year-old minute-grain job means half a million
no-op-ish windows. Prefer `backfill(range)` for intentional reprocessing.
_Tests:
`fail: hand-advanced unaligned watermark — whole bucket refolds, no
undercount`
· `fail: watermark rewound to the beginning — idempotent refold
converges`._

## 3. Late-arriving events are silently invisible to `run()`

**Failure.** An event written into an already-folded bucket sits behind the
watermark; `run()` reports `up-to-date` and the target is **silently stale**.
This is the sharpest operational edge in the v0.10 model.

**Today.** No detection. The data is not lost — the source still has it — but
nothing tells you a folded bucket no longer matches its source.

**Recovery.** `replay(db, job, bucketStart)` re-derives the affected bucket —
but the operator must _know which bucket_ the late rows landed in (e.g. by
querying the source for `occurred_at < watermark AND ingested_at > folded
time`,
which requires an ingestion timestamp the schema may not have). _Test:
`fail: late-arriving events land behind the watermark — replay
recovers`._

**Follow-up candidate.** A lateness allowance (fold `[from, until)` only when
`until <= now - lateness`) and/or a drift check (`status` comparing a folded
bucket's source count against the target).

## 4. A wrong clock parks the job as "up-to-date"

**Failure.** `run()` trusts the injected/ambient clock. A runner whose clock is
behind the watermark (skew, or a watermark advanced from a faster machine)
reports plain `up-to-date` forever — indistinguishable from genuinely being
current.

**Today.** `status()` is the observability hook: `next === null` while
`checkpoint.updatedAt` stops moving is the parked-job signature. Nothing alerts
on its own.

**Recovery.** Fix the clock; no state repair is needed (nothing was written).
_Test:
`fail: clock behind the watermark — job parks as up-to-date, status
shows it`._

## 5. The lock is a time-based lease, not a session lock

**Failure.** A runner that crashes while holding the lock leaves a lock row
behind; a runner that is alive but **slower than its TTL** (default 30 s) can be
raced by a second claimant that reaps the "expired" lease.

**Today.** Crash recovery is automatic — the next claimant reaps the expired
lease and proceeds, no operator action (verified with a 100 ms TTL). The
slow-holder race is real but bounded: even if two runners interleave, the
grain-keyed upsert and the atomic advance keep the target and checkpoint
consistent (the concurrent-race acceptance test pins this).

**Recovery / practice.** Size `options.lock.ttlMs` above the worst-case window
fold; long backfills hold the lock for the whole range. _Tests:
`fail: crashed lock holder — the lease expires and the next runner
self-heals` ·
features suite `etl: a concurrent race never double-counts`._

## 6. The rollup can only add or overwrite — it can never zero a bucket

**Failure.** `rollup()` is insert-from-select: a window whose source rows are
gone (pruned, or deleted upstream) upserts **nothing**. An
`unsafeAllowPrunedReplay` replay over a pruned window therefore "succeeds" while
leaving the stale counts untouched — it cannot shrink or clear them. Deletions
upstream never propagate to the target.

**Today.** The `ORM_REPLAY_PRUNED` guard refuses the pruned window by default,
and the unsafe override warns loudly — but the override's actual semantics are
"re-derive from whatever source exists," which for an empty source is a no-op,
not a zeroing.

**Recovery.** Restore the source rows, `DELETE` the target rows for the window,
then replay — re-derivation then reproduces the correct counts. _Test:
`fail: source rows pruned — unsafe replay CANNOT zero a bucket
(add/overwrite only)`._

**Follow-up candidate.** A `replay(..., { clear: true })` shape that deletes the
window's target rows in the same batch as the refold.

## 7. Schema drift between runs fails loudly but only at run time

**Failure.** A target column dropped (or retyped) after the job was defined
fails the next window's insert with a database error.

**Today.** Typed failure, watermark intact, resume-at-failed-window after the
schema is restored — the checkpoint's atomicity contract holds under drift. The
capability gate (`assertJobSupported`) probes the _renderer_, not the live
schema, so it cannot catch this pre-flight. _Test:
`fail: schema drift mid-life — typed error, resume after restore`._

## 8. Fine grains make catch-up chatty

**Observation.** Each window is one lock acquire + checkpoint read + one atomic
batch: ~0.3 s per window against local PostgreSQL. A minute-grain job that fell
a day behind needs 1 440 sequential runs (~7 min of round trips); the 90-window
drain in the battery takes ~26 s. Wide-window `backfill` has the same per-window
shape by design (deterministic, resumable), so it does not shortcut this.

**Practice.** Choose the coarsest grain the product tolerates; for bulk history,
prefer seeding + `backfill` over letting `run()` crawl; run catch-ups near the
database (latency dominates). _Test:
`limit: minute grain — 90 windows catch up in one drain`._

## Verified limits (the happy-path edges that hold)

From the same battery: 50 k events across 25 hourly windows reconcile exactly;
global rollups (no group keys) with composite `sql` aggregates and
`countDistinct` work; two jobs multiplex one checkpoint/lock table without
interference; events exactly on a bucket edge land in exactly one window
(half-open discipline); month grain agrees with `date_trunc` across calendar
lengths; 200-character job names fit the checkpoint/lock caps; bigint group keys
beyond 2^53 round-trip exactly as strings.
