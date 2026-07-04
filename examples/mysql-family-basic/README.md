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

## Notes

`update`/`delete` with no `where` throw unless you first call
`.unsafeAllowAllRows()`. Booleans round-trip as `0`/`1`. Columns are nullable by
default; `.notNull()` opts out.
