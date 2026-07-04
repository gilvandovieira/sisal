# PostgreSQL-family advanced SQL

## What this example teaches

That Sisal is a serious SQL builder, not just CRUD. It graduates the
[advanced-SQL contracts](../advanced-sql-contracts/README.md) into a runnable
workspace example for `@sisal/pg` / `@sisal/neon`, using **Sisal builders where
they exist** and a safe parameterized `sql` template only for the residual
shapes the public API doesn't yet cover.

Cases (see `src/statements.ts`): ETL rollup, window analytics, sessionization,
top-N per group, cohort retention, funnel analysis, recursive comments,
job-queue locking, idempotent backfill, JSON-table extraction, and generated
columns + expression/partial indexes.

## Packages used

`@sisal/orm`, `@sisal/pg` (+ `@sisal/pg/ddl`), `@sisal/neon`.

## Dialect target

PostgreSQL family — the richest advanced-SQL surface. `SISAL_ADAPTER` accepts
`pg`, `pg-db-postgres`, or `neon`.

## What is portable

The window functions (`over`/`rank`/`rowNumber`/`lag`), recursive CTEs
(`$withRecursive`), `filter(...)` aggregates, `jsonTable(...)`,
`insert().select()` rollups, and `FOR UPDATE SKIP LOCKED` locking are all
builder-native and render on every engine that supports the shape.

## What is dialect-specific

Postgres-native shapes shown here — `jsonb_to_recordset`, partial/expression
indexes, `date_trunc` intervals — differ or narrow on other engines; see the
MySQL and SQLite advanced-SQL siblings and
[`docs/feature-matrix.md`](../../docs/feature-matrix.md).

## How to run

```sh
# render every case to SQL (no database):
deno task render

# execute against a scratch database (rolled back):
DATABASE_URL=postgres://postgres:postgres@localhost:5432/scratch \
  SISAL_ADAPTER=pg deno task run

# golden-SQL render tests:
deno task test

# live integration (opt-in):
SISAL_POSTGRES_ADVANCED_SQL_IT=1 \
  DATABASE_URL=postgres://postgres:postgres@localhost:5432/scratch \
  deno task test:db
```

## Expected output

Each case's label and rendered, parameterized Postgres SQL. With `DATABASE_URL`,
the `run` task also executes the executable cases inside a transaction it rolls
back.

## Notes

Most cases are **builder-native** today; a few carry a documented residual `sql`
fragment (e.g. an interval threshold or a CTE-to-CTE `FROM`). Contracts 01 and
09 (ETL) are now better served by [`@sisal/etl`](../postgres-family-etl-cron/),
and 02 (windows) by [`@sisal/analytics`](../postgres-family-analytics/) — this
example keeps the hand-built SQL forms for comparison. See the
[contracts triage](../advanced-sql-contracts/README.md#triage-v0110).
