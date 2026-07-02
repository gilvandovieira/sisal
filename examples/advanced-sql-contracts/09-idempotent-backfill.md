# 09 — Idempotent backfill (documentation-only future contract)

**Status:** documentation-only future contract. Not runnable; not in the
workspace.

**Roadmap owner:** [v0.6](../../docs/v0.6.0-roadmap.md) Workstream A — **A3**
(checkpoint / watermark table design) and **A4** (idempotent load +
backfill/replay) → [v0.10 `@sisal/etl`](../../docs/v0.10.0-roadmap.md) (the
runner that resumes from the last committed window). v0.6 **designs** this; it
does not ship a runner.

**Related runnable examples:**
[`postgres-family-activity-vectors`](../postgres-family-activity-vectors/README.md)
(its rollups + event pruning are the load step a checkpoint protects) and
[01-etl-rollup](01-etl-rollup.md) (the rollup this watermarks).

## Product use case

An ETL job processes events in time windows. It must be able to **resume** after
a crash (start from the last committed window, not the beginning) and to
**backfill** an arbitrary historical range (re-run 2026-03 from scratch) —
**without double-counting**. The two ingredients: a **watermark table** that
records the last `window_end` committed per job, and an **idempotent load** so
replaying a window overwrites rather than appends.

## v0.6 decision

The checkpoint table is owned by the future `@sisal/etl` package by default, not
by `@sisal/migrate`. That keeps the package graph simple (`etl` does not gain a
migrate dependency) unless v0.9 reverses the decision with an explicit
architecture update.

The logical checkpoint table contract is:

```sql
sisal_etl_checkpoints (
  job primary key,
  window_end not null,
  pruned_before null,
  updated_at not null
)
```

Adapters may choose the physical timestamp type that matches their engine
(`timestamptz`, `text`, `datetime`, etc.), but the logical columns and meanings
are fixed:

- `job` — stable user-visible job id and the checkpoint primary key.
- `window_end` — exclusive end of the last committed live window.
- `pruned_before` — exclusive upper bound of **source rows removed by
  retention** for this job's source relation; `NULL` until the first prune. This
  is the job's **replay horizon** (see below).
- `updated_at` — when the checkpoint row was last advanced.

Runner semantics:

- `run()` acquires the job lock from
  [08-job-queue-locking](08-job-queue-locking.md), reads the checkpoint,
  computes the next half-open window `[from, until)`, performs the idempotent
  load, and advances `window_end` atomically with that load.
- `replay(window)` re-runs one explicit window with the same idempotent load and
  does **not** advance the live checkpoint by default.
- `backfill(range)` iterates explicit half-open windows across the range and
  does **not** disturb the live checkpoint by default.
- `replay`/`backfill` **refuse any window that begins before the replay
  horizon** (`from < pruned_before`) with a typed "window not replayable: source
  pruned" error — see the replay-vs-retention invariant below.

Idempotency invariants:

- Windows are half-open: `occurred_at >= from AND occurred_at < until`.
- The target table has a unique grain key such as `(post_id, bucket)`.
- Loads replace/upsert metric values for that grain; they do not add deltas to
  existing metrics.
- The load and checkpoint advance commit together in one transaction. A crash
  may leave the checkpoint behind already-loaded data, but never ahead of it.

## The replay-vs-retention invariant

Replace-semantics idempotence has a failure mode the ingredients above create
**together**: retention prunes raw source rows after consolidation (the
activity-vectors example deletes `post_events` once folded), and a later
`replay(window)` recomputes that window **from the now-missing rows** — then
_overwrites_ good rollups with zeros or undercounts. Nothing errors; the data is
silently destroyed by the very mechanism that was supposed to make re-runs safe.

The contract therefore binds replay to retention:

- **A window is replayable only while its source rows are fully retained**:
  `replay`/`backfill` require `from >= pruned_before`. Live `run()` is
  unaffected — its window always starts at `window_end`, which retention must
  never outrun (prune only what has been consolidated).
- **The prune advances `pruned_before` atomically with the delete** (one
  transaction), and the safe failure direction is the mirror image of the
  checkpoint's: `pruned_before` may run **ahead** of what was actually deleted
  (a refused replay that would have worked — annoying, correct), but must never
  lag it (an allowed replay over missing data — silent corruption).
- **The horizon is per-source, tracked per-job.** A job's `pruned_before` bounds
  replays of _that job's source relation_. Downstream jobs reading derived
  tables (e.g. `rollup_daily` reads hourly buckets, not raw events) carry their
  own horizon, bounded by _their_ source's retention — pruning raw events does
  not make daily-rollup replays unsafe.
- **The override is explicit.** Re-deriving from a different or restored source
  is legitimate (backfilling from an archive, recomputing a derived source); the
  runner exposes an `unsafeAllowPrunedReplay`-style opt-out mirroring the
  `.unsafeAllowAllRows()` safety-rail precedent — refused by default, loud when
  bypassed.

## SQL shape to preserve

```sql
-- 1. read the watermark (where did we get to?)
SELECT window_end FROM sisal_etl_checkpoints WHERE job = $job;

-- 2. load one window idempotently (upsert keyed on the rollup grain)
INSERT INTO post_hourly_stats (post_id, bucket, views, votes, comments)
SELECT post_id, date_trunc('hour', occurred_at),
       count(*) FILTER (WHERE kind='view'),
       count(*) FILTER (WHERE kind='vote'),
       count(*) FILTER (WHERE kind='comment')
FROM post_events
WHERE occurred_at >= $from AND occurred_at < $until
GROUP BY post_id, date_trunc('hour', occurred_at)
ON CONFLICT (post_id, bucket) DO UPDATE SET
  views = excluded.views, votes = excluded.votes, comments = excluded.comments;

-- 3. advance the watermark, atomically with the load
INSERT INTO sisal_etl_checkpoints (job, window_end, updated_at)
VALUES ($job, $until, now())
ON CONFLICT (job) DO UPDATE SET window_end = excluded.window_end,
                               updated_at = excluded.updated_at;

-- 4. retention (separate run): prune consolidated source rows AND advance the
--    replay horizon together, so the horizon never lags the delete
DELETE FROM post_events WHERE occurred_at < $before;
UPDATE sisal_etl_checkpoints SET pruned_before = $before, updated_at = now()
WHERE job = $job;
```

The load (2) and the watermark advance (3) must commit **together** (one
transaction / `db.batch`), so a crash never advances the watermark past
un-loaded data. The prune and the horizon advance (4) commit **together** for
the mirror-image reason (see the replay-vs-retention invariant). **Backfill** =
run step 2 for an explicit `[from, until)` that predates the watermark **and**
starts at or after `pruned_before`; idempotence makes it safe.

### v0.9 implementation note (T12)

v0.9 shipped the checkpoint substrate as `etlCheckpoint(db, job, options?)`
(steps 1–3): `read()` returns the last committed `window_end`, and
`advance(until, load)` runs the caller's idempotent load and the `window_end`
upsert as **one `db.batch`** — the atomic load+advance invariant. Two decisions
deviate from the sketch above and are deliberate: **watermarks are opaque TEXT**
(`window_end`/`pruned_before` are `varchar`, ISO-8601 by convention but the
caller owns the meaning) rather than per-adapter physical timestamp types — this
keeps the checkpoint uniform across every engine with no timestamp-decode
divergence; and the load+advance uses `db.batch` (non-interactive, which forbids
cross-statement reads — fine here, as the load never reads the watermark write).
The table's `CREATE TABLE IF NOT EXISTS` runs **outside** the atomic batch
because MySQL auto-commits DDL. The `pruned_before` retention horizon and the
`replay`/`backfill` refusal (step 4) remain **T14**; the run/replay/backfill
loop is the v0.10 runner.

**T13** validated this contract per engine and confirmed the A3 ownership
decision held (the substrate lives in `@sisal/orm`, not `@sisal/migrate` — no
`etl → migrate` edge; recorded in `architecture.md`). It added `readState()`
(the full `{ windowEnd, prunedBefore, updatedAt }` row) and per-engine scenarios
asserting exact TEXT round-trip fidelity, multi-job independence, `updated_at`
population, and resume across a fresh handle. Because watermarks are TEXT, the
"adapter-specific timestamp type" reconciliation the contract anticipated is not
needed — there is no per-engine timestamp surface.

**T14** shipped step 4 as the mirror of `advance`: `prune(before, deletes)`
upserts `pruned_before` in the **same `db.batch`** as the source delete (the
horizon never lags the delete), and `assertReplayable(from, options?)` throws a
typed `ORM_REPLAY_PRUNED` error when `from < pruned_before` — with the explicit
`unsafeAllowPrunedReplay` override this contract calls for. The
`run`/`replay`/`backfill` loop that drives these remains the v0.10 runner; T14
provides the substrate it composes.

## Required future Sisal primitives

- **The idempotent load** — `insert().select() … onConflictDoUpdate` — **shipped
  v0.5**; this is the [01-etl-rollup](01-etl-rollup.md) spine.
- **A checkpoint/watermark table contract (A3)** — a small typed system table
  (`job`, `window_end`, `pruned_before`, `updated_at`) with read/advance
  helpers. **Designed in v0.6 as the `@sisal/etl`-managed
  `sisal_etl_checkpoints` table; implemented and tested in v0.9/v0.10.**
- **Atomic load+advance** — `db.batch([...])` exists (non-interactive, atomic);
  it forbids cross-statement reads, which is fine here (the load doesn't read
  the watermark write).
- **A replay/backfill driver (A4)** — iterate `[from, until)` windows, skip or
  overwrite already-loaded ones deterministically, and **refuse windows behind
  the `pruned_before` replay horizon** (typed error; explicit unsafe override).
  **Design only** in v0.6; the loop is the v0.10 runner.
- **A run lock** so two runs don't advance the same watermark — from
  [08-job-queue-locking](08-job-queue-locking.md) (A2).

## Dialect classification

| Capability             | PostgreSQL       | Neon | SQLite     | libSQL   | future MySQL       |
| ---------------------- | ---------------- | ---- | ---------- | -------- | ------------------ |
| idempotent upsert load | ✅ builder       | ✅   | ✅ builder | ✅       | `ON DUPLICATE KEY` |
| watermark upsert       | ✅ builder       | ✅   | ✅ builder | ✅       | needs adapter      |
| atomic load + advance  | ✅ `db.batch`/tx | ✅   | ✅         | ✅       | needs adapter      |
| run lock               | ✅ advisory      | ✅   | lock row   | lock row | `GET_LOCK`         |

## Portable / emulatable / dialect-native / fail-guarded

- **Portable today:** the watermark table and the idempotent load are plain
  upserts — portable across all four engines right now.
- **Emulatable:** the run lock degrades per
  [08-job-queue-locking](08-job-queue-locking.md) (advisory lock on pg/mysql;
  lock row / `BEGIN IMMEDIATE` on sqlite/libsql).
- **Dialect-native:** none for the checkpoint itself.
- **Fail guarded → feature-matrix:** the checkpoint is portable, so no `❌`
  expected; only the **run lock** inherits the locking matrix row from
  [08-job-queue-locking](08-job-queue-locking.md).

## Non-goals

Not exactly-once across external sinks, not distributed consensus, not a
scheduler. A single-process resumable/backfillable batch load with a watermark —
the readiness design v0.6 owes v0.10.

## Future acceptance criteria

- A typed checkpoint helper reads/advances `sisal_etl_checkpoints` on every
  engine where ETL is supported.
- A crash between load and advance leaves the watermark **behind** the data
  (never ahead) — proven by an injected-failure test; re-running re-loads the
  window with no duplicates (idempotence).
- A backfill of an explicit historical range produces the same rollup as a fresh
  full run (replay determinism).
- **Replaying a window behind `pruned_before` is refused with a typed error** —
  proven by a test that prunes a consolidated window, attempts `replay`, asserts
  the refusal, and asserts the rollup row is **unchanged** (the zero-overwrite
  never happened). The mirror crash test: a failure between prune and horizon
  advance must leave the horizon **ahead or equal**, never behind the delete.
