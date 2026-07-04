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

## Sisal API pressure points

Like the PostgreSQL basic, this is the clean happy path — the builder carried
the full CRUD cycle, and SQLite supports `RETURNING`, so the update reads its
new row back builder-native (`mod.ts:58-59`). The only friction is inherent
dialect/driver behavior, not a Sisal gap:

1. **Booleans round-trip as `0`/`1`, so the archived flag prints `1`, not
   `true`.** Driver/engine limitation: SQLite (and therefore libSQL) has no
   native boolean type, so `archived` comes back as `1` (`mod.ts:57-60`). The
   example just prints it; no workaround is needed. Correctly not a Sisal gap.
2. **The native drivers need broad permissions (`-A` / FFI, libSQL also
   `--allow-sys`).** Driver/engine limitation: `@db/sqlite` loads a native
   library via FFI and the native libSQL client probes CPU/arch, so the tasks
   run with `-A`. Nothing in the ORM code works around it; it is a runtime
   permission fact, not a Sisal gap.
3. **The post-delete count is a raw `sql` query, not a builder helper — not a
   gap.** As in the PostgreSQL basic, `db.$count(notes)` covers this count
   builder-native; the raw `count(*)` (`mod.ts:66-68`) is kept only to
   demonstrate the `sql` / `db.query` escape hatch.

## Notes

`update`/`delete` with no `where` throw unless you first call
`.unsafeAllowAllRows()`. Columns are nullable by default; `.notNull()` opts out.
