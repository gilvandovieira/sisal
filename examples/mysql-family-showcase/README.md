# MySQL-family showcase

## What this example teaches

The broad "what Sisal can do today" tour on the MySQL family —
**generation-first**, with explicit MySQL/MariaDB honesty. It covers:

- `defineTable` across the MySQL type surface, foreign keys, unique, defaults,
  composite primary keys, and `$onUpdate`;
- generated MySQL DDL (backticks, `?` placeholders) and additive/destructive
  migration diffs;
- the query-builder surface rendered as MySQL SQL — operators, ordering, joins,
  aggregates + `groupBy` + `having`, `dateTrunc`, `filter(...)` aggregates,
  upsert → `ON DUPLICATE KEY UPDATE`, and an ETL-style rollup
  insert-from-select;
- **typed capability guards** — base-MySQL `RETURNING` raises a typed
  `OrmError`, shown rather than hidden;
- an optional **live** run that creates `sisal_showcase_*` tables and drops them
  in `finally` (MySQL DDL implicitly commits, so there is no rollback to hide
  behind).

## Packages used

`@sisal/orm`, `@sisal/migrate`, `@sisal/mysql`.

## Dialect target

MySQL family — one adapter for MySQL and MariaDB with detected identity. Pick
the live driver with `SISAL_ADAPTER` (`mysql2` | `mariadb`).

## What is portable

Schema/DDL generation, migration diffing, and the core builder surface are the
shared Sisal API.

## What is dialect-specific

No `FULL JOIN`, `DISTINCT ON`, native arrays, typed `db.call`, or data-modifying
CTEs; `dateTrunc` returns text; booleans round-trip as `0`/`1`; MySQL JSON reads
back parsed while MariaDB JSON reads back as text; base MySQL has no `RETURNING`
(a typed guard) while MariaDB lights it up through detected identity. The live
path branches on `db.dialectIdentity.variant` to show the MariaDB vs MySQL
divergence. See [`docs/feature-matrix.md`](../../docs/feature-matrix.md).

## How to run

```sh
# generation only (no database):
deno task ddl

# also execute a compact live tour:
MYSQL_URL=mysql://root:root@localhost:3306/sisal \
  deno task run
# SISAL_ADAPTER=mysql2 (default) | mariadb
```

Environment variables:

```
MYSQL_URL=         # or MARIADB_URL, or DATABASE_URL — optional; enables the live tour
```

`docker/compose.yaml` does not currently provide MySQL/MariaDB; point the URL at
your own server.

## Expected output

Sectioned output: generated DDL, classified migration diffs, builder SQL
(including the `FILTER`/`dateTrunc` rollup and the typed `RETURNING` guard), and
— with a URL — a live tour that creates, queries, upserts, folds a rollup, then
drops its tables.

## Notes

Columns are nullable by default; `.notNull()` opts out. Check the feature matrix
before promising a behavior across adapters.
