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

## Notes

This example reads the rollup that
[`postgres-family-etl-cron`](../postgres-family-etl-cron/README.md) produces —
`post_events` → `post_hourly_stats`. In a real pipeline the ETL job populates
the table on a schedule; here the live path seeds a small deterministic rollup
(idempotent upsert) so the reads return rows on a fresh database. ETL builds the
rollups; analytics reads them.
