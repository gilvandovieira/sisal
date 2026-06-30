# 06 — Funnel analysis (documentation-only future contract)

**Status:** documentation-only future contract. Not runnable; not in the
workspace.

**Roadmap owner:** [v0.7](../../docs/v0.7.0-roadmap.md) Workstream A (analytics
readiness — first-event windows + period comparisons) →
[v0.11 `@sisal/analytics`](../../docs/v0.11.0-roadmap.md). The
**conditional-aggregation core is buildable today**; the per-user **first-event
ordering** and the **period-over-period comparison** are the analytics
primitives that push it to v0.7/v0.11.

**Related runnable examples:**
[`neon-activity-vectors`](../neon-activity-vectors/README.md) (the `post_events`
stream a funnel is computed from) and the `*-rising-feed` examples.

## Product use case

Measure a conversion funnel over user events: **visited → signed up → created a
post → shared**. Each step counts the distinct users who reached _at least_ that
step, so the dashboard shows drop-off between stages — optionally compared to
the **previous period** (this week vs last week) to see whether conversion is
improving.

## SQL shape to preserve

```sql
WITH first_events AS (                  -- first time each user hit each step
  SELECT user_id, kind,
         min(occurred_at) AS first_at
  FROM post_events
  WHERE kind IN ('visit','signup','create','share')
  GROUP BY user_id, kind
),
per_user AS (                           -- pivot the steps onto one row per user
  SELECT user_id,
         max(first_at) FILTER (WHERE kind = 'visit')  AS visited_at,
         max(first_at) FILTER (WHERE kind = 'signup') AS signed_up_at,
         max(first_at) FILTER (WHERE kind = 'create') AS created_at,
         max(first_at) FILTER (WHERE kind = 'share')  AS shared_at
  FROM first_events
  GROUP BY user_id
)
SELECT
  count(*) FILTER (WHERE visited_at   IS NOT NULL) AS visited,
  count(*) FILTER (WHERE signed_up_at IS NOT NULL) AS signed_up,
  count(*) FILTER (WHERE created_at   IS NOT NULL) AS created,
  count(*) FILTER (WHERE shared_at    IS NOT NULL) AS shared
FROM per_user;
```

## Required future Sisal primitives

- **Conditional aggregation** (`count(*) FILTER (WHERE …)`, `max(...) FILTER`) —
  `filter()` **shipped v0.5**, native on the SQLite family. The funnel core is
  buildable **today**.
- **First-event timestamps** (`min(occurred_at) GROUP BY user_id, kind`) —
  buildable today.
- **The step pivot** — a clean `filter`-per-step projection; needs the typed
  alias surface ([01-etl-rollup](01-etl-rollup.md)) to infer the step columns.
- **Period comparison** (this window vs previous) — analytics-IR territory
  (v0.7): two parameterized windows + a delta. Optionally `lag` over periodized
  rollups, which needs [02-window-analytics](02-window-analytics.md).

## Dialect classification

| Capability                  | PostgreSQL          | Neon | SQLite           | libSQL | future MySQL  |
| --------------------------- | ------------------- | ---- | ---------------- | ------ | ------------- |
| `FILTER` conditional counts | ✅ builder          | ✅   | ✅ native (v0.5) | ✅     | `CASE WHEN`   |
| first-event `min` + group   | ✅ builder          | ✅   | ✅ builder       | ✅     | needs adapter |
| period-over-period delta    | analytics IR (v0.7) | …    | …                | …      | …             |

## Portable / emulatable / dialect-native / fail-guarded

- **Portable today:** the entire single-period funnel (first-events → pivot →
  conditional counts) builds on all four engines now.
- **Emulatable:** on a future MySQL adapter, `FILTER` → `COUNT(CASE WHEN …)` /
  `MAX(CASE WHEN …)`; semantically identical (see
  [12-mysql-compatibility](12-mysql-compatibility.md)).
- **Dialect-native:** none for the single-period funnel.
- **Fail guarded → feature-matrix:** nothing fails for the core funnel; only the
  _period-comparison_ extension may need windows, inheriting the
  [02-window-analytics](02-window-analytics.md) `❌` until v0.7/v0.11.

## Non-goals

Not multi-touch attribution, not arbitrary user-defined funnel steps at runtime,
not a funnel-builder UI. A fixed-step funnel over an events table, optionally
compared across two periods.

## Future acceptance criteria

- The single-period funnel renders entirely through the builder on all four
  engines and matches a TypeScript recomputation on a fixture with known
  per-user step times.
- The optional period comparison is expressed via the v0.7 analytics IR (two
  windows + delta) and pinned per dialect.
- The MySQL `CASE WHEN` emulation of `FILTER` is proven equal to the Postgres
  `FILTER` form on the same fixture.
