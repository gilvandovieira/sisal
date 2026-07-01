# 08 — Job-queue locking (documentation-only future contract)

**Status:** documentation-only future contract. Not runnable; not in the
workspace.

**Roadmap owner:** [v0.6](../../docs/v0.6.0-roadmap.md) Workstream A — **A2**
(advisory-lock / per-dialect locking strategy) →
[v0.10 `@sisal/etl`](../../docs/v0.10.0-roadmap.md) (the single-run runner needs
exactly this so two runs don't process the same window twice). **Partly built
already:** the `SELECT … FOR UPDATE SKIP LOCKED` builder _exists_ — the gap is
the **SQLite/libSQL alternative strategy** and a **portable lock abstraction**.

**Related runnable examples:**
[`postgres-family-hot-feed`](../postgres-family-hot-feed/README.md) (its atomic
vote + "four ways to make a multi-step change atomic" table is the same
concurrency discipline) and
[`postgres-family-activity-vectors`](../postgres-family-activity-vectors/README.md)
(the rollup chain a worker would drive).

## Product use case

A worker pulls the next job from a `jobs` table, processes it, and marks it done
— with **N workers running concurrently** and **no job processed twice**. On
Postgres/MySQL the idiomatic claim is `FOR UPDATE SKIP LOCKED`: each worker
locks and grabs a different unlocked row in one statement. On the SQLite family
there is no row-lock clause, so the strategy must differ (a single-writer
`BEGIN IMMEDIATE` claim, or a `claimed_by`/`claimed_at` compare-and-set update).

## v0.6 decision

The v0.10 ETL runner needs a **coarse whole-job run lock** in addition to any
future row-claim helper. v0.6 does not build that lock, but it fixes the
contract v0.9 must implement and test before v0.10 consumes it:

- **Lock identity:** every ETL run locks a stable logical name
  `sisal:etl:<job>`, where `<job>` is the user-visible job id. Implementations
  may hash or escape that string to satisfy an engine's lock API, but the
  logical key is the contract.
- **PostgreSQL / Neon:** use a session-scoped advisory lock,
  `pg_try_advisory_lock(<hash64>)`, and release it with
  `pg_advisory_unlock(<hash64>)` on the same session. The 64-bit key is derived
  deterministically from `sisal:etl:<job>`; the migration history store's
  advisory-lock hashing is the existing pattern to reuse.
- **SQLite / libSQL:** for supported local or interactive runs, wrap the
  checkpoint read, idempotent load, and checkpoint advance in `BEGIN IMMEDIATE`
  so only one writer can run the job window at a time. If the runtime cannot
  provide that transactional writer lock safely, the future ETL API must
  capability-gate the job shape instead of silently degrading.
- **Future MySQL / MariaDB:** use named locks with `GET_LOCK(name, 0)` and
  `RELEASE_LOCK(name)` using the same `sisal:etl:<job>` logical name.

This is a **design contract**, not a feature-matrix claim. v0.9 owns the
per-engine implementation and contention tests; v0.10 may only consume the lock
after those tests exist.

## SQL shape to preserve

```sql
-- Postgres / MySQL: claim one job, skipping rows other workers hold
WITH next AS (
  SELECT id FROM jobs
  WHERE status = 'pending'
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE jobs SET status = 'running', claimed_at = now()
FROM next WHERE jobs.id = next.id
RETURNING jobs.*;
```

```sql
-- SQLite / libSQL: no row locks — atomic compare-and-set claim instead
UPDATE jobs SET status = 'running', claimed_by = $worker, claimed_at = $now
WHERE id = (
  SELECT id FROM jobs WHERE status = 'pending'
  ORDER BY created_at LIMIT 1
)
  AND status = 'pending'          -- CAS guard; relies on BEGIN IMMEDIATE
RETURNING *;
```

## Required future Sisal primitives

- **`.for("update", { skipLocked })`** — `SELECT … FOR UPDATE SKIP LOCKED` —
  **already ships** (Postgres/MySQL; typed
  `dialectGuard('.for(...) row locking',
  ["sqlite"])` throws on the SQLite
  family). The lock builder is **not** the gap.
- **A data-modifying CTE reading the locked rows** —
  `db.with(...).update(t)
  .from(...)` + `RETURNING` — **shipped v0.5
  (item 12)** on the Postgres family (guarded on SQLite).
- **A portable "claim next" abstraction** that picks `FOR UPDATE SKIP LOCKED` on
  pg/mysql and the CAS-update + `BEGIN IMMEDIATE` path on sqlite/libsql — **this
  is the missing piece** (A2). It must encode the locking _capability_, not
  assume Postgres.
- **A portable advisory lock** (`pg_advisory_lock` ↔ MySQL `GET_LOCK` ↔ SQLite
  `BEGIN IMMEDIATE` / lock-row) for coarse, whole-job mutual exclusion —
  **designed in v0.6, implemented/tested in v0.9, consumed by v0.10**.

## Dialect classification

| Capability                  | PostgreSQL            | Neon | SQLite     | libSQL     | future MySQL  |
| --------------------------- | --------------------- | ---- | ---------- | ---------- | ------------- |
| `FOR UPDATE SKIP LOCKED`    | ✅ builder            | ✅   | ❌ guarded | ❌ guarded | ✅ (engine)   |
| data-modifying CTE claim    | ✅ builder (v0.5)     | ✅   | ❌ guarded | ❌ guarded | needs adapter |
| `BEGIN IMMEDIATE` CAS claim | —                     | —    | ✅         | ✅         | —             |
| advisory lock               | ✅ `pg_advisory_lock` | ✅   | lock row   | lock row   | `GET_LOCK`    |

## Portable / emulatable / dialect-native / fail-guarded

- **Portable abstraction (to build):** "claim next pending job" — one method,
  two renderings, capability-gated.
- **Emulatable:** the SQLite/libSQL CAS-update claim is a real, correct
  emulation of `SKIP LOCKED` for a **single-writer** queue (SQLite serializes
  writers anyway); document that it does _not_ give Postgres-style concurrent
  multi-grab.
- **Dialect-native:** `FOR UPDATE SKIP LOCKED` (pg/mysql) and `BEGIN IMMEDIATE`
  (sqlite) are each native and non-portable — the abstraction picks one.
- **Fail guarded → feature-matrix:** `FOR UPDATE SKIP LOCKED` is **already `❌`
  (guarded) on the SQLite family** — the contract's job is to make sure the
  _portable claim_ degrades to the CAS path there instead of throwing, and to
  add a `claim-next-job` / `advisory-lock` row to
  [`docs/feature-matrix.md`](../../docs/feature-matrix.md) classifying each
  engine (✅ native / ⚠️ CAS emulation / ❌).

## Non-goals

Not a job framework, not retries/backoff/dead-letter policy, not a cron, not
priorities. One "claim → process → complete" cycle that is safe under
concurrency, plus the honest per-dialect locking note.

## Future acceptance criteria

- A portable `claimNextJob(...)` renders `FOR UPDATE SKIP LOCKED` on pg/neon
  (and future mysql) and the CAS-update claim on sqlite/libsql.
- A concurrency test (N workers) processes every job **exactly once** on each
  engine — Postgres via real `SKIP LOCKED`, SQLite via serialized CAS.
- The advisory-lock abstraction guards a whole-window ETL run (ties to
  [09-idempotent-backfill](09-idempotent-backfill.md)), with the per-dialect
  strategy recorded in the feature matrix after v0.9 has backing tests.
