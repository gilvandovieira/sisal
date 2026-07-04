# SQLite-family basic

## What this example teaches

The first five minutes with Sisal on the SQLite family. It:

1. defines a small schema with `defineTable`;
2. generates and prints the `CREATE TABLE` DDL;
3. connects (in-memory by default — **zero setup**) and runs one full CRUD cycle
   — **insert → typed select → update (RETURNING) → delete → count**;
4. binds every value as a parameter;
5. closes the connection cleanly in `finally`.

## Packages used

`@sisal/orm`, `@sisal/sqlite` (+ `@sisal/sqlite/ddl`), `@sisal/libsql`.

## Dialect target

SQLite family. The dialect + builder are shared and `SqliteDatabase` ≡
`LibsqlDatabase`, so the same code runs over embedded `@sisal/sqlite` or
`@sisal/libsql`/Turso — pick with `SISAL_ADAPTER`.

## What is portable

The schema, builder, CRUD, and safety rails are the shared Sisal surface.

## What is dialect-specific

Booleans round-trip as `0`/`1` on SQLite (the `archived` update prints `1`).
SQLite has no server; the embedded driver loads a native library via FFI (hence
`-A` on first run).

## How to run

```sh
# embedded @sisal/sqlite, in-memory (zero setup):
deno task run

# over @sisal/libsql (local file by default; Turso with env below):
SISAL_ADAPTER=libsql deno task run
```

Environment variables:

```
SISAL_SQLITE_PATH=       # optional; a file path instead of :memory:
TURSO_DATABASE_URL=      # optional; libsql/Turso endpoint
TURSO_AUTH_TOKEN=        # optional; Turso auth token
```

`deno task run` uses `-A` because `@db/sqlite` loads a native library (FFI) and
libSQL may write a local file.

## Expected output

The generated `CREATE TABLE "notes" (...)` DDL, then the selected title, the
archived flag (`1`), and the post-delete count (`0`).

## Notes

`update`/`delete` with no `where` throw unless you first call
`.unsafeAllowAllRows()`. Columns are nullable by default; `.notNull()` opts out.
