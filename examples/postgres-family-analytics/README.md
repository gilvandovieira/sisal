# PostgreSQL-family analytics

## What this example teaches

`@sisal/analytics` — the typed read side of the ETL story. You describe a query
as **metrics × dimensions × windows** (typed descriptor maps), and Sisal
compiles it to one correct, parameterized SQL statement with a result-row type
inferred from the definition. It shows:

- `from(rollup)` over the `post_hourly_stats` table the ETL example writes;
- `bucket("hour" | "day", …)` time dimensions;
- aggregate metrics — `sum`, `max`, `countDistinct`;
- windowed metrics — `movingAvg` (6h velocity) and `rank` (per-community);
- `compareToPreviousWindow(metric)` for period-over-period deltas;
- `orderBy` / `limit`;
- `supportsQuery(...)` preflight and `render(...)` dry-run, then `execute(db)`.

It is the analytics counterpart of the hand-written `/rising` feed
([`postgres-family-feed`](../postgres-family-feed/README.md)): the same "rising
posts" idea expressed declaratively over a rollup instead of stored functions.

## Packages used

`@sisal/analytics`, `@sisal/orm` (schema + insert), `@sisal/pg` (+
`@sisal/pg/ddl`).

## Dialect target

PostgreSQL. `@sisal/analytics` is Postgres-first; other engines are
capability-gated. The same query runs unchanged over `@sisal/neon`.

## What is portable

The query definition and `render`/`execute` surface are dialect-neutral. Plain
metrics × dimensions × `bucket` time series render on every supported engine.

## What is dialect-specific

Windowed metrics (`movingAvg`, `rank`), `compareToPreviousWindow`, and the
experimental percentile helpers are Postgres-first. Call
`supportsQuery(query,
identity)` (or `assertQuerySupported`) before executing on
another engine — an unsupported shape fails typed
(`ANALYTICS_UNSUPPORTED_QUERY`), never as a raw engine error.

## How to run

```sh
# dry-run: render + capability-check every query (no database)
deno task render

# live: create the rollup table, seed a demo rollup, execute
DATABASE_URL=postgres://postgres:postgres@localhost:5432/scratch \
  deno task run

# network-free render tests
deno task test
```

Environment variables:

```
DATABASE_URL=      # optional; when set, seeds a demo rollup and executes
```

## Expected output

Dry-run prints each query's `supported on postgres: true` line and its rendered
SQL (with `to_char(date_trunc(...))` buckets, `rank() over (...)`, a 6-row
moving-average frame, and `viewsPrevious`/`viewsDelta` period-comparison
columns). With `DATABASE_URL`, it also prints the top rising-feed rows and the
daily-trend row count.

## Sisal API pressure points

This is a **resolved destination**: every query in `mod.ts` is a fully typed
`@sisal/analytics` descriptor — dimensions, metrics, `windows`,
`compareToPreviousWindow`, `orderBy`/`limit` — and renders to parameterized SQL
with **no raw `sql` anywhere** (contrast the hand-written `/rising` feed in
[`postgres-family-feed`](../postgres-family-feed/README.md)). The remaining
limits are about reach, not escape hatches:

1. **Windowed analytics are Postgres-first; there is no MySQL/SQLite analytics
   yet** — SQL/dialect limitation (honest scope). `movingAvg`, `rank`, and
   `compareToPreviousWindow` (`mod.ts:88`–`99`) render window functions;
   `supportsQuery(query, { dialect: "postgres" })` preflights each
   (`mod.ts:125`) so an unsupported engine fails typed
   (`ANALYTICS_UNSUPPORTED_QUERY`) rather than at the engine. Plain metrics ×
   dimensions × `bucket` are portable; the windowed shapes are not.
2. **No derived / computed metric — arithmetic over metrics isn't expressible**
   — API gap. The weighted engagement signal is _read_ as a pre-materialized
   column (`engagement: max(p.engagementScore)`, `mod.ts:86`); the weighting
   (`votes*2 + comments*3 + views*0.25`) had to be folded upstream by
   `@sisal/etl` because analytics has no way to combine `sum(votes)`,
   `sum(comments)`, and `sum(views)` into one metric expression. The same gap
   the ETL example hits from the write side.
3. **pg-family `bigint` reads back as a string** — driver/engine limitation.
   `postId` is a `bigint` (`mod.ts:48`) and comes back as a string; the example
   prints it as-is. Consistent with the cross-adapter bigint contract, not an
   analytics issue.

Not pressure points: `sum`, `max`, `countDistinct`, `bucket`, `movingAvg`,
`rank`, and `compareToPreviousWindow` are all analytics-native and type-infer
the result row.

## Notes

This example reads the rollup that
[`postgres-family-etl-cron`](../postgres-family-etl-cron/README.md) produces —
`post_events` → `post_hourly_stats`. In a real pipeline the ETL job populates
the table on a schedule; here the live path seeds a small deterministic rollup
(idempotent upsert) so the reads return rows on a fresh database. ETL builds the
rollups; analytics reads them.
