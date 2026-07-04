# SQLite-family advanced SQL

Runnable conservative advanced SQL examples for embedded SQLite and libSQL.

SQLite coverage is intentionally narrower than PostgreSQL and MySQL. The example
probes capabilities and runs each case only when its feature is supported,
printing a skip line otherwise: ETL rollup, window analytics, sessionization,
top-N per group, cohort retention, funnel analysis, recursive CTEs, a
compare-and-set queue claim, JSON extraction through `json_each`, and generated
columns/partial indexes where supported.

## Commands

```sh
deno task render

SISAL_SQLITE_ADVANCED_SQL_IT=1 deno task run

SISAL_SQLITE_ADVANCED_SQL_IT=1 deno task test:db

SISAL_ADAPTER=libsql SISAL_LIBSQL_URL=file:./sisal-advanced-sql.sqlite \
  SISAL_SQLITE_ADVANCED_SQL_IT=1 deno task run
```

The live path probes support before running optional features and prints a skip
line for missing capabilities.

## Coverage

- Builder-native (capability-probed): ETL rollup, window analytics
  (`over`/`rank`), sessionization, top-N (`over(rowNumber)`), cohort retention,
  funnel analysis, recursive CTEs (`$withRecursive`), and JSON extraction
  (`jsonTable(...)` → `json_each`). Some cases keep a documented residual inline
  `sql` fragment.
- Raw / DDL: the CAS `UPDATE … RETURNING` queue claim (SQLite has no row locks)
  and hand-written generated-column + partial-index DDL.
- Skipped first pass: **idempotent backfill only** (checkpoint semantics) — it
  is `@sisal/etl`'s job; see
  [`postgres-family-etl-cron`](../postgres-family-etl-cron/). MySQL
  compatibility is not applicable to this family.

See the [contracts triage](../advanced-sql-contracts/README.md#triage-v0110).
