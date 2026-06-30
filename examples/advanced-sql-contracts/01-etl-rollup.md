# 01 — ETL rollup (documentation-only future contract)

**Status:** documentation-only future contract. Not runnable; not in the
workspace.

**Roadmap owner:** [v0.6](../../docs/v0.6.0-roadmap.md) Workstream A — **A1**
(verify + pin the builder rollup), **A3** (checkpoint table), **A4** (idempotent
load + backfill) — handed to [v0.10 `@sisal/etl`](../../docs/v0.10.0-roadmap.md)
for the runner. This is the **most-built** contract in the directory: v0.5
shipped almost every piece; what remains is _verification_, not new primitives.

**Related runnable examples:**
[`neon-activity-vectors`](../neon-activity-vectors/README.md) (the runnable PoC:
`post_events` → hourly buckets → stats → rollups + pruning),
[`neon-rising-feed-ctes`](../neon-rising-feed-ctes/README.md) (builder-native
`UPDATE … FROM` over chained CTEs), and the `*-rising-feed` siblings that
already bucket activity.

## Product use case

Raw, high-volume `post_events` (`view` / `vote` / `comment`) arrive faster than
any dashboard wants to scan. The ETL job folds a half-open time window
`[from, until)` into a `post_hourly_stats` rollup — one row per
`(post_id, hour)` with `views`, `votes`, `comments`, `engagement_score` — and
**re-running the same window is a no-op** (idempotent upsert keyed on the rollup
grain). Dashboards then read the small rollup, never the firehose.

## SQL shape to preserve

```sql
INSERT INTO post_hourly_stats
  (post_id, bucket, views, votes, comments, engagement_score)
SELECT post_id,
       date_trunc('hour', occurred_at)            AS bucket,
       count(*) FILTER (WHERE kind = 'view')      AS views,
       count(*) FILTER (WHERE kind = 'vote')      AS votes,
       count(*) FILTER (WHERE kind = 'comment')   AS comments,
       /* weighted blend of the three counts */   AS engagement_score
FROM post_events
WHERE occurred_at >= $from AND occurred_at < $until
GROUP BY post_id, date_trunc('hour', occurred_at)
ON CONFLICT (post_id, bucket) DO UPDATE SET
  views = excluded.views, votes = excluded.votes,
  comments = excluded.comments, engagement_score = excluded.engagement_score;
```

## Required future Sisal primitives

Almost all of this **already ships** — the contract exists to _pin_ it, not to
build it:

- `insert(t).select(query)` — INSERT … SELECT — **shipped v0.5 (item 12)**, all
  four engines.
- `onConflictDoUpdate(...)` — **shipped**.
- `filter(agg, cond)` — `count(*) FILTER (WHERE …)` — **shipped v0.5 (item 9)**,
  native on the SQLite family.
- `dateTrunc` / `dateBin` — the hour bucket — **shipped v0.5**.
- `groupBy` + aggregates — **shipped**.

Genuinely missing (the v0.6 → v0.10 work):

- A **typed alias surface** for rollup metric columns (`AS views`) that survives
  inference cleanly (today partial).
- A **checkpoint / watermark** table abstraction (A3) — see
  [09-idempotent-backfill](09-idempotent-backfill.md).
- A **locking** strategy so two runners don't double-load a window (A2) — see
  [08-job-queue-locking](08-job-queue-locking.md).

## Dialect classification

| Capability         | PostgreSQL | Neon       | SQLite           | libSQL           | future MySQL       |
| ------------------ | ---------- | ---------- | ---------------- | ---------------- | ------------------ |
| insert-from-select | ✅ builder | ✅ builder | ✅ builder       | ✅ builder       | needs adapter      |
| `FILTER` aggregate | ✅ builder | ✅ builder | ✅ native (v0.5) | ✅ native (v0.5) | `CASE WHEN`        |
| date bucket        | ✅ builder | ✅ builder | ✅ `strftime`    | ✅ `strftime`    | `DATE_FORMAT`      |
| upsert-from-select | ✅         | ✅         | ✅               | ✅               | `ON DUPLICATE KEY` |

## Portable / emulatable / dialect-native / fail-guarded

- **Portable today:** the whole rollup spine on pg/neon/sqlite/libsql — this is
  the rare contract that is portable _now_.
- **Emulatable:** on a future MySQL adapter, `FILTER` → `SUM(CASE WHEN …)`,
  `date_trunc` → `DATE_FORMAT`/`FLOOR`, upsert → `ON DUPLICATE KEY UPDATE` (see
  [12-mysql-compatibility](12-mysql-compatibility.md)).
- **Dialect-native:** none required.
- **Fail guarded → feature-matrix:** nothing here should fail; if a future
  dialect cannot express idempotent upsert-from-select, that becomes a `❌`
  `upsert-from-select` row in
  [`docs/feature-matrix.md`](../../docs/feature-matrix.md).

## Non-goals

Not a scheduler, not a worker daemon, not `@sisal/etl` itself. One window, one
run, triggered by hand in the example. No streaming, no CDC, no Kafka.

## Future acceptance criteria

- A runnable example (per dialect, since the SQLite family diverges) builds the
  rollup **entirely through the builder** — no raw `INSERT … SELECT` string.
- Re-running the same `[from, until)` window leaves `post_hourly_stats`
  byte-for- byte identical (idempotence test).
- A gated integration test asserts the builder-rendered statement equals the
  hand-written SQL above on each engine, and that the rollup matches a
  TypeScript recomputation of the same window.
- The `upsert-from-select` and `date bucket` rows in the feature matrix stay ✅.
