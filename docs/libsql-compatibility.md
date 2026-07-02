---
title: libSQL / Turso compatibility
---

# libSQL / Turso compatibility

Sisal's libSQL adapter (`@sisal/libsql`) is verified end-to-end against a real
libSQL database. libSQL is a SQLite fork, so the SQL surface matches SQLite;
what differs is the **connection** — a local `file:`, an in-memory database, or
a remote **Turso** URL with an auth token (and embedded replicas).

| Item          | Value                                                  |
| ------------- | ------------------------------------------------------ |
| Engine tested | **libSQL** (SQLite-compat **3.45.1**)                  |
| Driver        | `npm:@libsql/client@0.17.4`                            |
| Transport run | Local `file:` (set `TURSO_DATABASE_URL` to test Turso) |
| Suite         | `integration/libsql_features_test.ts` (40 tests)       |
| Last run      | 2026-07-01 — **40 / 40 passed**                        |

## Feature coverage

Every feature across all four adapters — each ✅/⚠️ backed by a named
integration test — lives in the unified
[cross-driver feature matrix](feature-matrix.md), verified by
`deno task docs:matrix:check`. libSQL is a SQLite fork that renders identical
SQL (`LIBSQL_DIALECT = "sqlite"`), so its column-naming, keyset, prepared,
`db.batch`, and `sql`-in-`SET`/`VALUES` rows match SQLite; the libSQL-specific
round-trip differences and connection notes are below.

**v0.9 additions.** libSQL inherits the SQLite-family behavior for the portable
ETL substrate — the advisory lock is a **lock-row lease**
(`db.tryAdvisoryLock`), plus `etlCheckpoint` (watermark/retention) and
`tryInsert` (write-outcome via `RETURNING`); read/`WITH RECURSIVE` CTEs are
covered per-engine and data-modifying CTEs are guarded off. All are in the
[feature matrix](feature-matrix.md).

## Behavior notes

> The cross-driver round-trip differences and PostgreSQL-only limits are
> documented once in the
> [feature-matrix reference](feature-matrix.md#round-trip-differences); the
> notes below add libSQL-specific detail.

libSQL shares SQLite's type system, so the SQLite notes apply verbatim:

- **`ilike` / `notIlike` degrade to `LIKE` / `NOT LIKE`**
  (ASCII-case-insensitive; libSQL has no `ILIKE` keyword).
- **Binary** (`columns.bytea()` → `BLOB`) round-trips, but `@libsql/client`
  returns BLOBs as `ArrayBuffer` (SQLite and Postgres return `Uint8Array`) —
  wrap with `new Uint8Array(value)`.
- **JSON and arrays round-trip as text** — auto-serialized to JSON `TEXT`;
  `JSON.parse` on read.
- **Date/time values are `TEXT`** — `date`, `time`, `timestamp`, and
  `timestamptz` store ISO strings. Temporal params are normalized before
  reaching `@libsql/client`; enable `temporal: { parse: true }` to decode known
  ORM-built result columns back into Temporal values. Raw SQL rows are not
  inferred from names or storage text.
- **Booleans are `INTEGER` `0`/`1`**; `numeric`/`bigint` map to `REAL`/`INTEGER`
  affinity and return as numbers.
- **`serial`/`bigserial`** map to `INTEGER` under a table-level `PRIMARY KEY`
  (not the rowid auto-increment).
- **Column naming, keyset pagination, and prepared statements behave identically
  to PostgreSQL.** camelCase keys map to snake_case columns (or
  `.named()`/`preserve`), `.keyset(...)` returns `{ rows, nextCursor }` for both
  the `"expanded"` and `"row-value"` predicate forms, and `placeholder()` +
  `.prepare()` bind by name — all rendered through the shared SQLite SQL path.
- **Postgres-only constructs throw a typed error** — `.distinctOn(...)`,
  `.for("update" | "share")` locking, and the array operators
  (`arrayContains`/`arrayContained`/`arrayOverlaps`) are PostgreSQL-only; using
  one against libSQL throws an `OrmError` at render time (v0.5.0 item 4). See
  the [PostgreSQL-only limits](feature-matrix.md#postgresql-only-limits)
  reference.

What is **specific to libSQL/Turso**:

- **Connection.** `connect({ url, authToken? })` accepts `file:…`, `:memory:`,
  and remote `libsql://…` / `https://…turso.io` URLs. Turso needs an
  `authToken`. The CLI scaffolds these via `sisal init --target libsql`.
- **Remote transport.** Against Turso, statements travel over HTTP (hrana); the
  feature results are identical, but latency and network errors apply.
- **Embedded replicas / sync.** `syncUrl`/`syncInterval` (offline-first
  replicas) are passed straight through to `@libsql/client`; they don't change
  SQL behavior.
- **Integers.** `@libsql/client` returns large integers per its `intMode`;
  coerce with `Number(...)` (or use `bigint` mode) when you need a JS number.

## Reproduce

```sh
# Local libSQL (temp file)
SISAL_LIBSQL_IT=1 deno test -A integration/libsql_features_test.ts

# Against a real Turso database
SISAL_LIBSQL_IT=1 \
  TURSO_DATABASE_URL="libsql://<db>.turso.io" \
  TURSO_AUTH_TOKEN="<token>" \
  deno test -A integration/libsql_features_test.ts
```

The suite is **skipped unless `SISAL_LIBSQL_IT=1`**, so it never runs during the
ordinary `deno task test`.
