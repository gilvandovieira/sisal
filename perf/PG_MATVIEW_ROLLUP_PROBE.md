# CF2 probe — materialized-view rollup vs the generated-SQL rollup

**Question (v0.10 CF2, investigate-first):** for the canonical
`post_events → post_hourly_stats` shape, does a `CREATE MATERIALIZED VIEW` +
`REFRESH` path beat the `@sisal/etl` generated rollup — and can it fit the
runner model (checkpointed, incremental, capability-gated, never silently
degraded)?

**Decision: recorded defer.** The matview path loses on the operational
dimension that matters (incremental cost), cannot express the runner's
checkpoint/resume/backfill/replay semantics, and is Postgres-only. Evidence
below; probe: `perf/pg_matview_probe.ts` (`deno task perf:pg:matview`).

## Method

PostgreSQL 18.4 (docker `pg18`, local socket), postgres.js driver (the v0.10
default), median of 5 runs per timing. Events seeded server-side across 24
hourly buckets, 100 posts, `occurred_at` indexed, `ANALYZE`d. Four paths:

1. **Incremental window fold** — the exact `rollup()` statement `run()` sends,
   for one hour window (steady-state runner cost).
2. **Full rollup rebuild** — the same generated upsert over all 24 hours as one
   statement (a whole-history `backfill` upper bound).
3. **`REFRESH MATERIALIZED VIEW`** — Postgres's only refresh: full recompute
   under an `ACCESS EXCLUSIVE` lock (readers block).
4. **`REFRESH ... CONCURRENTLY`** — full recompute + diff; needs a unique index;
   readers keep working.

## Results (2026-07-02)

| Path                                 | 100k events  | 1M events   |
| ------------------------------------ | ------------ | ----------- |
| Incremental fold (1 window, `run()`) | **2.4 ms**   | **11.4 ms** |
| Full rollup rebuild (24 windows)     | 32.9 ms      | 198.8 ms    |
| `REFRESH MATERIALIZED VIEW`          | 22.8 ms      | 85.6 ms     |
| `REFRESH ... CONCURRENTLY`           | 39.5 ms      | 91.1 ms     |
| Refresh ÷ incremental                | 9.5× / 16.5× | 7.5× / 8.0× |

## Findings

- **Steady state, the matview is 7.5–16.5× slower** than the incremental fold —
  and this probe is charitable to it: only 24 h of history are retained.
  `REFRESH` recomputes **all** retained history every time (O(total)), while the
  runner's fold scans one bucket (O(window)). With months of history the gap is
  unbounded; with retention pruning the ETL model's cost never grows at all.
- **A matview cannot be windowed.** No checkpoint, no resume, no deterministic
  `backfill(range)`, no per-window `replay`, no replay-horizon guard — the v0.10
  acceptance semantics simply do not map onto "recompute everything." It would
  be a second, semantically different engine behind the same API.
- **Postgres-only.** SQLite/libSQL have no materialized views; MySQL has none
  either. Gating it per-engine would fork runner behavior — exactly the
  "silently-degraded runner" the release forbids.
- **Operational costs on top:** plain `REFRESH` blocks readers
  (`ACCESS EXCLUSIVE`); `CONCURRENTLY` requires a unique index, roughly doubles
  transient storage, and was _slower_ than plain refresh at both scales here.
- **One honest counter-point, recorded for later:** for a _full recompute_,
  `REFRESH` beat the upsert-based full rebuild ~2× (85.6 ms vs 198.8 ms at 1M) —
  the bare `CREATE`-style rewrite avoids per-row `ON CONFLICT` work. If a
  "rebuild the whole rollup from scratch" fast path is ever wanted, `TRUNCATE` +
  plain insert-select (or a matview used as a one-shot build artifact) is the
  shape to probe — as an explicit maintenance verb, not as the runner.

## Disposition

CF2 closes as **defer with evidence** (per the v0.10 acceptance criterion: "a
capability-gated implementation _or_ a recorded defer with benchmark evidence").
The generated-SQL incremental rollup remains the only runner path on every
engine. Revisit only if a genuinely incremental matview mechanism ships in
PostgreSQL (`pg_ivm`-style maintenance in core) or if a whole-history rebuild
verb is added to the ETL surface.
