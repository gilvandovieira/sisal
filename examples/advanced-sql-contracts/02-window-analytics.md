# 02 — Window analytics (documentation-only future contract)

**Status:** documentation-only future contract. Not runnable; not in the
workspace.

**Roadmap owner:** [v0.7](../../docs/v0.7.0-roadmap.md) Workstream A (analytics
readiness — design the analytical IR and the `over()` surface) →
[v0.11 `@sisal/analytics`](../../docs/v0.11.0-roadmap.md) (ships the metric ×
dimension × window API). **Sisal has no window-function builder of any kind
today** — this is the single biggest analytics gap, recorded by
[v0.6 A6](../../docs/v0.6.0-roadmap.md) as the PoC's hard wall.

**Related runnable examples:**
[`neon-activity-vectors`](../neon-activity-vectors/README.md) (its `vote_ma_6h`
/ `comment_ma_6h` moving averages are raw
`avg(…) OVER (… ROWS BETWEEN 5 PRECEDING AND CURRENT ROW)` — exactly the wall
this contract names), and the `*-rising-feed` examples whose moving-window score
is hand-written in SQL/TS.

## Product use case

A feed/analytics surface that needs **relative** measures, not just totals: a
post's votes as a **moving average** over the last 6 hourly buckets, its
**rank** within its community this hour, the **delta vs the previous bucket**
(`lag`/`lead`). These are the signals a `/rising` feed and an analytics
dashboard are built from, and none of them can be expressed without window
functions.

## SQL shape to preserve

```sql
SELECT post_id,
       bucket,
       votes,
       avg(votes) OVER (
         PARTITION BY post_id ORDER BY bucket
         ROWS BETWEEN 5 PRECEDING AND CURRENT ROW
       )                                            AS vote_ma_6h,
       votes - lag(votes) OVER (
         PARTITION BY post_id ORDER BY bucket
       )                                            AS vote_delta,
       rank() OVER (
         PARTITION BY community_id, bucket ORDER BY votes DESC
       )                                            AS hour_rank
FROM post_hourly_stats;
```

## Required future Sisal primitives

All **absent** — there is no `over()` surface at all:

- A window clause builder: `over({ partitionBy, orderBy, frame })`.
- Frame specs: `ROWS`/`RANGE BETWEEN n PRECEDING AND CURRENT ROW`.
- Window functions: `lag`, `lead`, `firstValue`, `lastValue`, `nthValue`.
- Ranking functions: `rowNumber`, `rank`, `denseRank`, `ntile`, `percentRank`.
- Windowed aggregates: `sum`/`avg`/`count` usable **as** window functions (reuse
  the existing aggregate operators with an `.over(...)`).
- Result typing for the computed window columns.

## Dialect classification

| Capability           | PostgreSQL | Neon | SQLite (modern) | libSQL | future MySQL (8+) |
| -------------------- | ---------- | ---- | --------------- | ------ | ----------------- |
| `OVER` / `PARTITION` | engine ✅  | ✅   | engine ✅       | ✅     | engine ✅         |
| frame `ROWS BETWEEN` | engine ✅  | ✅   | engine ✅       | ✅     | engine ✅         |
| `lag`/`lead`/`rank`  | engine ✅  | ✅   | engine ✅       | ✅     | engine ✅         |
| **Sisal builder**    | ❌ none    | ❌   | ❌ none         | ❌     | ❌ none           |

The engines (incl. modern SQLite and MySQL 8) all support window functions — the
gap is entirely **Sisal-side**. The IR must still gate per-dialect: frame and
percentile coverage on the SQLite family is narrower than Postgres.

## Portable / emulatable / dialect-native / fail-guarded

- **Portable (once built):** `OVER (PARTITION BY … ORDER BY …)` and basic
  ranking render on all four engines + MySQL 8.
- **Emulatable:** nothing clean — windows have no correlated-subquery rewrite
  worth shipping; the IR should require the engine to support them.
- **Dialect-native / degraded:** percentiles (`percentile_cont`/`disc`) and some
  frame modes are Postgres-first; classify each as portable / degraded /
  Postgres-first in the analytics IR (v0.7).
- **Fail guarded → feature-matrix:** when the builder lands, an engine that
  cannot run a requested window (e.g. an older SQLite frame mode) must throw a
  typed `dialectGuard`, and that becomes a `❌` window-function row in
  [`docs/feature-matrix.md`](../../docs/feature-matrix.md) — not a raw engine
  error.

## Non-goals

Not a full OLAP engine; not percentiles-everywhere; not a DuckDB pushdown (that
is v0.13+). The example demonstrates moving averages + ranking + lag deltas on a
rollup table, nothing more.

## Future acceptance criteria

- A typed `over({...})` builder renders the SQL above on pg/neon and modern
  sqlite/libsql, with the result row inferring the window columns.
- Per-dialect render tests pin the frame syntax; unsupported frames throw a
  typed guard with a feature-matrix `❌` to match.
- The `*-rising-feed` moving-window score is rebuilt on the window builder and
  matches the current hand-written SQL/TS to the last decimal.
