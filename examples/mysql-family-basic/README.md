# MySQL-family basic

## What this example teaches

The first five minutes with Sisal on the MySQL family. It:

1. defines a small schema with `defineTable`;
2. generates and prints the MySQL `CREATE TABLE` DDL (zero setup);
3. with a database URL set, connects and runs one full CRUD cycle — **insert →
   typed select → update → delete → count**;
4. binds every value as a parameter (`?` placeholders);
5. closes the connection cleanly in `finally`.

## Packages used

`@sisal/orm`, `@sisal/mysql` (one adapter for both MySQL and MariaDB).

## Dialect target

MySQL family. One adapter, detected identity: `SISAL_ADAPTER=mysql2` (default,
`npm:mysql2`) or `SISAL_ADAPTER=mariadb` (the MariaDB connector).

## What is portable

The schema, builder, and safety rails are the shared Sisal surface.

## What is dialect-specific

MySQL proper has **no `INSERT ... RETURNING`**, so this example reads the serial
id back with a typed select on the unique email instead of returning it from the
insert, and the update reads back rather than returning. (MariaDB does support
`RETURNING` through detected identity; see the MySQL showcase.)

## How to run

```sh
# just print the DDL (no database):
deno task ddl

# connect + full CRUD:
MYSQL_URL=mysql://root:root@localhost:3306/sisal \
  deno task run
# SISAL_ADAPTER=mysql2 (default) | mariadb
```

Environment variables:

```
MYSQL_URL=         # or MARIADB_URL, or DATABASE_URL — optional; DDL prints without it
```

`docker/compose.yaml` does not currently provide MySQL/MariaDB; point the URL at
your own server.

## Expected output

The generated `CREATE TABLE sisal_basic_users (...)` DDL, then (with a URL) the
selected `#id name`, and the post-delete count.

## Sisal API pressure points

The one place a basic CRUD cycle diverges on the MySQL family is `RETURNING`,
and it is correctly a driver/engine limitation, not a Sisal gap:

1. **MySQL proper has no `INSERT ... RETURNING`, so the inserted row is read
   back with a separate typed select.** Driver/engine limitation: MySQL 8/9 has
   no `RETURNING` clause, so the example inserts, then selects the serial `id`
   and `name` back by the unique `email` (`mod.ts:64-69`). Correctly not a Sisal
   gap — and Sisal already ships the builder-native answer for "give me the rows
   I just inserted": `@sisal/mysql`'s `insertReturning(db, table, values)`,
   which tries real `RETURNING` (lit on MariaDB ≥ 10.5) and otherwise does a
   fetch-by-key fallback, recovering an `AUTO_INCREMENT` / `serial` id via
   `LAST_INSERT_ID`. The basic example does the manual select on purpose, to
   keep the first-five-minutes flow transparent and engine-agnostic.
2. **The update has no `RETURNING` either, so it does not read its new row
   back.** Driver/engine limitation: base MySQL has no `UPDATE ... RETURNING`
   (MariaDB's is version-gated), so the example updates by `email` and moves on
   without a returned row (`mod.ts:71-73`). `insertReturning` covers inserts but
   not updates; a returned-row update on base MySQL would need a follow-up
   select. Correctly not a Sisal gap.
3. **The post-delete count is a raw `sql` query, not a builder helper — not a
   gap.** As in the sibling basics, `db.$count(users)` covers this count
   builder-native; the raw `count(*)` (`mod.ts:80-82`) is kept only to show the
   `sql` / `db.query` escape hatch.

## Notes

`update`/`delete` with no `where` throw unless you first call
`.unsafeAllowAllRows()`. Booleans round-trip as `0`/`1`. Columns are nullable by
default; `.notNull()` opts out.
