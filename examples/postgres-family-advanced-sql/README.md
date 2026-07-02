# PostgreSQL-family advanced SQL

Runnable advanced SQL examples for `@sisal/pg` and `@sisal/neon`.

This package graduates the advanced SQL contracts into a real workspace example.
Sisal builders are used where they exist. Engine-supported SQL that is missing a
builder primitive uses the safe `sql` template with bound parameters, and the
missing primitive is logged in the v0.8 roadmap.

## Commands

```sh
deno task render

DATABASE_URL=postgres://postgres:postgres@localhost:5432/scratch \
  SISAL_ADAPTER=pg deno task run

SISAL_POSTGRES_ADVANCED_SQL_IT=1 \
  DATABASE_URL=postgres://postgres:postgres@localhost:5432/scratch \
  deno task test:db
```

`SISAL_ADAPTER` accepts `pg`, `pg-postgres-js`, or `neon`. The live run executes
inside a transaction and deliberately rolls it back.

## Coverage

- Builder-native: ETL rollup, row locking.
- Parameterized raw SQL: windows, sessionization, top-N, cohorts, funnels,
  recursive CTEs, JSON table extraction, generated columns, expression indexes,
  and partial indexes.
- Cross-reference: MySQL compatibility is covered by the MySQL-family advanced
  example and the existing MySQL-family showcase/feed examples.
