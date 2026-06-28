---
title: libSQL / Turso compatibility
---

# libSQL / Turso compatibility matrix

Sisal's libSQL adapter (`@sisal/libsql`) is verified end-to-end against a real
libSQL database. libSQL is a SQLite fork, so the SQL surface matches SQLite;
what differs is the **connection** — a local `file:`, an in-memory database, or
a remote **Turso** URL with an auth token (and embedded replicas).

| Item          | Value                                                  |
| ------------- | ------------------------------------------------------ |
| Engine tested | **libSQL** (SQLite-compat **3.45.1**)                  |
| Driver        | `npm:@libsql/client@0.17.4`                            |
| Transport run | Local `file:` (set `TURSO_DATABASE_URL` to test Turso) |
| Suite         | `integration/libsql_features_test.ts` (25 tests)       |
| Last run      | 2026-06-28 — **25 / 25 passed**                        |

✅ = verified · ⚠️ = works with a documented behavior difference · ❌ =
unsupported (SQLite-family).

## Matrix

| Feature                                                                 | libSQL |
| ----------------------------------------------------------------------- | :----: |
| **Connection** — `connect({ url, authToken? })`                         |   ✅   |
| **Generated DDL applies** — affinity mapping of all types               |   ✅   |
| **Temporal date/time modes** — parse opt-in, strings, legacy Date modes |   ✅   |
| **Insert** — `values`, multi-row, `returning`                           |   ✅   |
| **Comparison** — `eq` `ne` `gt` `gte` `lt` `lte`                        |   ✅   |
| **Pattern** — `like` / `notLike`                                        |   ✅   |
| **Pattern** — `ilike` / `notIlike` (degrades to `LIKE`)                 |   ✅   |
| **Range** — `between` / `notBetween`                                    |   ✅   |
| **Set** — `inArray` / `notInArray`                                      |   ✅   |
| **Null** — `isNull` / `isNotNull`                                       |   ✅   |
| **Logical** — `and` `or` `not`                                          |   ✅   |
| **Ordering** — `asc`/`desc`, multi-key, `limit`, `offset`               |   ✅   |
| **Distinct**                                                            |   ✅   |
| **Joins** — `inner` / `left` / `right` / `full`                         |   ✅   |
| **Aggregates** — `count` `sum` `avg` `min` `max`                        |   ✅   |
| **Aggregate** — `countDistinct`; `db.$count(table, where?)`             |   ✅   |
| **Subquery** — `exists` / `notExists` (correlated)                      |   ✅   |
| **Subquery** — derived `.as()`, scalar, `inArray(subquery)`             |   ✅   |
| **Group / filter** — `groupBy`, `having`                                |   ✅   |
| **Update** — `set`, `where`, `returning`, `$onUpdate`                   |   ✅   |
| **Delete** — `where`, `returning`                                       |   ✅   |
| **Upsert** — `onConflictDoNothing` / `onConflictDoUpdate`               |   ✅   |
| **Transactions** — commit + rollback on error                           |   ✅   |
| **Boolean** — round-trip                                                |   ⚠️   |
| **JSON / JSONB** — object round-trip                                    |   ⚠️   |
| **Arrays** — `text[]` round-trip                                        |   ⚠️   |
| **Binary** — `bytea`/`BLOB` round-trip                                  |   ⚠️   |
| **Migrator** — apply, plan, history table, idempotent re-run            |   ✅   |

## Behavior notes

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
- **Postgres-only operators are unavailable** — `.distinctOn(...)`,
  `.for("update" | "share")` locking, and the array operators
  (`arrayContains`/`arrayContained`/`arrayOverlaps`).

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
