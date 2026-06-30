# 09 — Idempotent backfill (documentation-only future contract)

**Status:** documentation-only future contract. Not runnable; not in the
workspace.

**Roadmap owner:** [v0.6](../../docs/v0.6.0-roadmap.md) Workstream A — **A3**
(checkpoint / watermark table design) and **A4** (idempotent load +
backfill/replay) → [v0.10 `@sisal/etl`](../../docs/v0.10.0-roadmap.md) (the
runner that resumes from the last committed window). v0.6 **designs** this; it
does not ship a runner.

**Related runnable examples:**
[`neon-activity-vectors`](../neon-activity-vectors/README.md) (its rollups +
event pruning are the load step a checkpoint protects) and
[01-etl-rollup](01-etl-rollup.md) (the rollup this watermarks).

## Product use case

An ETL job processes events in time windows. It must be able to **resume** after
a crash (start from the last committed window, not the beginning) and to
**backfill** an arbitrary historical range (re-run 2026-03 from scratch) —
**without double-counting**. The two ingredients: a **watermark table** that
records the last `window_end` committed per job, and an **idempotent load** so
replaying a window overwrites rather than appends.

## SQL shape to preserve

```sql
-- 1. read the watermark (where did we get to?)
SELECT window_end FROM etl_checkpoint WHERE job = $job;

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
INSERT INTO etl_checkpoint (job, window_end, updated_at)
VALUES ($job, $until, now())
ON CONFLICT (job) DO UPDATE SET window_end = excluded.window_end,
                               updated_at = excluded.updated_at;
```

The load (2) and the watermark advance (3) must commit **together** (one
transaction / `db.batch`), so a crash never advances the watermark past
un-loaded data. **Backfill** = run step 2 for an explicit `[from, until)` that
predates the watermark; idempotence makes it safe.

## Required future Sisal primitives

- **The idempotent load** — `insert().select() … onConflictDoUpdate` — **shipped
  v0.5**; this is the [01-etl-rollup](01-etl-rollup.md) spine.
- **A checkpoint/watermark table contract (A3)** — a small typed system table
  (`job`, `window_end`, `updated_at`) with read/advance helpers. **Absent.**
  Open question (v0.6): owned by `@sisal/etl` or a `@sisal/migrate`-managed
  system table?
- **Atomic load+advance** — `db.batch([...])` exists (non-interactive, atomic);
  it forbids cross-statement reads, which is fine here (the load doesn't read
  the watermark write).
- **A replay/backfill driver (A4)** — iterate `[from, until)` windows, skip or
  overwrite already-loaded ones deterministically. **Design only** in v0.6; the
  loop is the v0.10 runner.
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

- A typed checkpoint helper reads/advances the watermark on all four engines.
- A crash between load and advance leaves the watermark **behind** the data
  (never ahead) — proven by an injected-failure test; re-running re-loads the
  window with no duplicates (idempotence).
- A backfill of an explicit historical range produces the same rollup as a fresh
  full run (replay determinism).
