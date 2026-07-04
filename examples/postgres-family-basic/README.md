# PostgreSQL-family basic

## What this example teaches

The first five minutes with Sisal on the PostgreSQL family. It:

1. defines a small schema with `defineTable`;
2. generates and prints the `CREATE TABLE` DDL (zero setup, no database);
3. with `DATABASE_URL` set, connects and runs one full CRUD cycle — **insert →
   typed select → update (RETURNING) → delete → count**;
4. binds every value as a parameter (nothing is string-interpolated);
5. closes the connection cleanly in `finally`.

One table, one connection, one screen of code.

## Packages used

`@sisal/orm`, `@sisal/pg` (+ `@sisal/pg/ddl`), `@sisal/neon`.

## Dialect target

PostgreSQL family. The dialect + builder are shared and `NeonDatabase` ≡
`PgDatabase`, so the same code runs over `@sisal/pg` (postgres.js or
`@db/postgres`) or `@sisal/neon` — pick with `SISAL_ADAPTER`.

## What is portable

Everything here (schema, builder, CRUD, safety rails) is identical across every
Sisal adapter; only the connection and rendered placeholders differ.

## What is dialect-specific

Nothing in this example — it is the shared surface. See the SQLite and MySQL
basics for the same shape on their engines, and the showcases for dialect
divergences.

## How to run

```sh
# just print the DDL (no database):
deno task ddl

# connect + full CRUD over a chosen driver:
DATABASE_URL=postgres://postgres:postgres@localhost:5432/scratch \
  deno task run
# SISAL_ADAPTER=pg (default) | pg-db-postgres | neon
```

Environment variables:

```
DATABASE_URL=      # optional; without it the example only prints DDL
NEON_WS_PROXY=     # optional; for a local neon-proxy under SISAL_ADAPTER=neon
```

## Expected output

The generated `CREATE TABLE "users" (...)` DDL, then (with `DATABASE_URL`) the
selected row, the updated name, and the post-delete count.

## Sisal API pressure points

This basic example is the clean happy path. The fluent builder carried the whole
CRUD cycle — insert, typed select, `update(...).returning()`, delete — with no
dialect guards, driver quirks, or raw-SQL workarounds in the mutation code.
PostgreSQL supports `RETURNING`, so the update reads its new row back
builder-native (`mod.ts:73-74`). One honest, non-gap note:

1. **The post-delete count is a raw `sql` query, not a builder helper — not a
   gap.** `db.$count(users)` is builder-native and covers exactly this count;
   the example keeps the raw `count(*)` query (`mod.ts:82-84`) only to show the
   parameterized `sql` / `db.query` escape hatch exists. Correctly not a Sisal
   gap.

## Notes

`update`/`delete` with no `where` throw unless you first call
`.unsafeAllowAllRows()` — the safety rail against an accidental
delete-everything. Columns are nullable by default; `.notNull()` opts out and
`.primaryKey()` implies not-null.
