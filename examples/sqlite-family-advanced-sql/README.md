# SQLite-family advanced SQL

Runnable conservative advanced SQL examples for embedded SQLite and libSQL.

SQLite coverage is intentionally narrower than PostgreSQL and MySQL. The example
includes only cases that can be probed and skipped cleanly: ETL rollup, modern
window queries, recursive CTEs, a compare-and-set queue claim, JSON extraction
through `json_each`, and generated columns/partial indexes where supported.

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

- Builder-native: ETL rollup.
- Parameterized raw SQL when capability probes pass: windows, top-N, recursive
  CTEs, CAS queue claim, JSON extraction, generated columns, partial indexes.
- Skipped first pass: sessionization, cohort retention, funnel analysis, and
  idempotent backfill.
