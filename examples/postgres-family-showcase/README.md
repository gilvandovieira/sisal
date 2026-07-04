# PostgreSQL-family showcase

## What this example teaches

The broad "what Sisal can do today" tour on the PostgreSQL family —
**generation-first**, so it runs with no database and prints the artifacts Sisal
produces, then optionally executes them. It covers:

- `defineTable` across the full Postgres type surface (uuid, numeric, jsonb,
  arrays, bytea, timestamps), foreign keys, unique, defaults, and `$onUpdate`;
- generated `CREATE TABLE` DDL and additive/destructive migration diffs
  (`planSchemaChanges` classifies and withholds destructive changes);
- the query-builder surface rendered as real Postgres SQL — projection,
  boolean/comparison/range/set/null operators, native `ILIKE`, ordering +
  limit/offset + distinct, joins, aggregates + `groupBy` + `having`, multi-row
  insert + `RETURNING`, upsert (`onConflictDoUpdate`), update + delete;
- a **live** run over any Postgres-family driver, inside a transaction that is
  rolled back so your database is left untouched (jsonb/array round-trip typed).

## Packages used

`@sisal/orm`, `@sisal/migrate`, `@sisal/pg` (+ `@sisal/pg/ddl`), `@sisal/neon`.

## Dialect target

PostgreSQL family — the richest showcase. The dialect backs both `@sisal/pg` and
`@sisal/neon`; pick the live driver with `SISAL_ADAPTER` (`pg` |
`pg-db-postgres` | `neon`).

## What is portable

The whole builder surface, schema/DDL generation, and migration diffing are the
shared Sisal API — the same code shapes work on every adapter.

## What is dialect-specific

Native `ILIKE`, `jsonb`, `text[]` arrays, and `bytea` are Postgres strengths
shown here; the SQLite and MySQL showcases demonstrate where those degrade or
differ (e.g. `ILIKE` → case-insensitive `LIKE`, arrays/JSON serialized to text).

## How to run

```sh
# generation only (no database, no permissions):
deno task render

# also execute against a scratch database (rolled back), over a chosen driver:
DATABASE_URL=postgres://postgres:postgres@localhost:5432/scratch \
  deno task run
# SISAL_ADAPTER=pg (default) | pg-db-postgres | neon
```

Environment variables:

```
DATABASE_URL=      # optional; enables the live (rolled-back) run
NEON_WS_PROXY=     # optional; for a local neon-proxy under SISAL_ADAPTER=neon
```

## Expected output

Sectioned output: generated DDL across the full type surface, classified
migration diffs, and every builder shape rendered as Postgres SQL. With
`DATABASE_URL`, a live transaction that inserts, joins, round-trips
jsonb/arrays, and then rolls back.

## Notes

Columns are nullable by default; `.notNull()` opts out and `.primaryKey()`
implies not-null. The live path uses a `Rollback` sentinel so nothing persists.
