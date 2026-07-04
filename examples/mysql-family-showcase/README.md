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

## Sisal API pressure points

Honest gaps this example ran into, kept distinct from the MySQL-family dialect
limits Sisal guards for you. The MySQL divergences below are authoritative per
the "MySQL-family divergences" bullet in `CLAUDE.md`.

1. **Base-MySQL `.returning()` is a typed guard; the example uses the
   `insertReturning` fetch-by-key fallback.** _Driver/engine limitation
   (correctly NOT a Sisal gap)._ Rendering `insert(...).returning()` raises an
   `OrmError` that the demo catches and prints (`mod.ts:158`–`mod.ts:164`,
   `mod.ts:286`–`mod.ts:298`); live code reaches for
   `insertReturning(db, users,
   {...})` instead (`mod.ts:355`). MariaDB lights
   real `RETURNING` up through detected identity — the fallback is only for
   MySQL proper.
2. **Arithmetic in the rollup's `engagement` column falls back to the raw `sql`
   template.** _API gap._ `votes * 2.0 + comments * 3.0` has no
   expression-arithmetic builder, so it is hand-written through the `sql` tag
   inside an otherwise fully builder-native insert-from-select (`mod.ts:316`–
   `mod.ts:318`, and again live at `mod.ts:463`–`mod.ts:465`). Numeric
   expression operators are the primitive that would close it.
3. **A data-modifying CTE needs a hand-written branch on
   `db.dialectIdentity.variant`.** _Driver/engine limitation (the branch is the
   friction)._ MariaDB parses `WITH` only on `SELECT`, so a CTE-prefixed
   mutation is a typed guard; the example branches to a derived-table
   `update(posts).from(big)` for MariaDB versus `db.with(big).update(posts)` for
   MySQL (`mod.ts:429`–`mod.ts:443`). The divergence is a real engine limit, but
   the manual `variant` switch is the workaround Sisal makes you write.
4. **Table teardown uses raw `drop table if exists` — the DDL pipeline is
   additive-only.** _API gap (by design)._ Cleanup drops the five tables via
   `raw(...)` (`mod.ts:483`–`mod.ts:489`) because generators emit only additive
   SQL and withhold destructive changes; there is no programmatic drop builder
   to express the teardown that MySQL's implicit DDL commit forces here.
5. **MySQL timestamps are hand-formatted in TypeScript.** _API gap (ergonomic)._
   `timestamp({ mode: "string" })` columns need `YYYY-MM-DD HH:MM:SS.ffffff`, so
   the example ships a `mysqlTimestamp(new
   Date())` helper
   (`mod.ts:491`–`mod.ts:493`) used by both `$onUpdate` (`mod.ts:91`) and
   inserts (`mod.ts:295`). The Postgres twin passed `new Date()` straight into a
   `mode: "date"` column; a MySQL `mode: "date"` that formats on write would
   remove the helper.
6. **`ILIKE` degrades to `LIKE`, `text[]` has no native MySQL type, `dateTrunc`
   returns text.** _Driver/engine limitations (correctly NOT Sisal gaps)._
   `ilike(...)` renders as `LIKE` (`mod.ts:252`–`mod.ts:260`);
   `tags:
   columns.text().array()` has no native array type to map to
   (`mod.ts:88`); and the rollup's `dateTrunc("hour", ...)` returns text
   (`mod.ts:308`). All three are engine behavior Sisal reports faithfully, not
   missing primitives.

## Notes

Columns are nullable by default; `.notNull()` opts out. Check the feature matrix
before promising a behavior across adapters.
