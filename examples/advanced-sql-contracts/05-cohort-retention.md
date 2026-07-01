# 05 — Cohort retention (documentation-only future contract)

**Status:** documentation-only future contract. Not runnable; not in the
workspace.

**Roadmap owner:** straddles two milestones —
[v0.6](../../docs/v0.6.0-roadmap.md) A1/A3/A4 (the ETL rollup + checkpoint that
builds the cohort table) and [v0.7](../../docs/v0.7.0-roadmap.md) →
[v0.11 `@sisal/analytics`](../../docs/v0.11.0-roadmap.md) (the retention query
over it). It is **ETL + analytics**: ETL materializes the cohort grid, analytics
reads it.

**Related runnable examples:**
[`neon-activity-vectors`](../postgres-family-activity-vectors/README.md)
(daily/monthly rollups + retention framing already live here) and
[`postgres-family-feed`](../postgres-family-feed/README.md) (chained CTEs).

## Product use case

Group users by **signup cohort** (the week/month they joined), then measure how
many return in each subsequent period: "of the users who signed up in 2026-W10,
what % were active in week +1, +2, … +8?". The output is the classic retention
triangle — a cohort × period grid of return rates that drives every growth
dashboard.

## SQL shape to preserve

```sql
WITH cohorts AS (                       -- one row per user → their cohort week
  SELECT user_id,
         date_trunc('week', created_at) AS cohort_week
  FROM users
),
activity AS (                           -- distinct weeks each user was active
  SELECT DISTINCT user_id,
         date_trunc('week', occurred_at) AS active_week
  FROM post_events
),
grid AS (
  SELECT c.cohort_week,
         (a.active_week - c.cohort_week) AS period_offset,
         count(DISTINCT a.user_id)       AS retained
  FROM cohorts c
  JOIN activity a USING (user_id)
  WHERE a.active_week >= c.cohort_week
  GROUP BY c.cohort_week, period_offset
)
SELECT cohort_week, period_offset, retained,
       retained::numeric
         / first_value(retained) OVER (             -- cohort size = offset 0
             PARTITION BY cohort_week ORDER BY period_offset
           ) AS retention_rate
FROM grid
ORDER BY cohort_week, period_offset;
```

## Required future Sisal primitives

- **CTE chaining + `JOIN … USING`** — `db.with(...)` and joins exist; the
  cohort/activity/grid CTEs are buildable today (SELECT-only, so portable).
- **Date bucketing** — `dateTrunc('week', …)` — **shipped v0.5**.
- **Conditional / distinct aggregation** — `count(DISTINCT …)`, `filter(...)` —
  **shipped**.
- **A window function** for the cohort-size normalization (`first_value` /
  windowed `max`) — **absent**, from
  [02-window-analytics](02-window-analytics.md). Without it, the rate is
  computed in a second pass / in TypeScript.
- A **rollup table** to persist the grid (so dashboards don't recompute) — the
  ETL side, [01-etl-rollup](01-etl-rollup.md) +
  [09-idempotent-backfill](09-idempotent-backfill.md).

## Dialect classification

| Capability                          | PostgreSQL | Neon | SQLite (modern) | libSQL | future MySQL (8+) |
| ----------------------------------- | ---------- | ---- | --------------- | ------ | ----------------- |
| CTE grid + `count(DISTINCT)`        | ✅ builder | ✅   | ✅ builder      | ✅     | needs adapter     |
| week bucketing                      | ✅ builder | ✅   | ✅ `strftime`   | ✅     | `YEARWEEK`        |
| `first_value` normalization         | engine ✅  | ✅   | engine ✅       | ✅     | engine ✅         |
| **window normalization in builder** | ❌         | ❌   | ❌              | ❌     | ❌                |

## Portable / emulatable / dialect-native / fail-guarded

- **Portable today:** the cohort/activity/grid CTEs (counts, distinct, buckets,
  join) build on every engine right now — only the final rate normalization
  needs windows.
- **Emulatable:** the cohort-size divisor can be a **self-join to the offset-0
  row** instead of `first_value`, which works on window-less engines — a clean
  emulation the example can show as the portable fallback.
- **Dialect-native:** `period_offset` as week subtraction differs (Postgres date
  math vs SQLite `julianday` vs MySQL `TIMESTAMPDIFF`) — normalize via the
  portable duration abstraction.
- **Fail guarded → feature-matrix:** if a target lacks both window functions
  _and_ the self-join emulation is undesirable, the window normalization is the
  `❌` cell; the rest of the cohort grid stays ✅.

## Non-goals

Not a cohort-explorer UI, not predictive retention/LTV modelling, not
event-attribution. A batch query producing the retention triangle from `users` +
`post_events`.

## Future acceptance criteria

- The cohort grid builds entirely through the builder on all four engines; the
  rate normalization uses the v0.7 window surface where present and the
  self-join emulation otherwise, both proven equal on a fixture.
- Re-running the ETL that persists the grid is idempotent (ties to
  [09-idempotent-backfill](09-idempotent-backfill.md)).
- Known cohorts produce the exact expected retention curve on every engine.
