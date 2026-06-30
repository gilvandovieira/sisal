---
title: PostgreSQL compatibility
---

# PostgreSQL compatibility

Sisal's PostgreSQL adapter (`@sisal/pg`) is verified end-to-end against a real
server on every supported major version. The suite connects with the bundled
`jsr:@db/postgres@0.19.5` driver, applies generated DDL, and exercises every
adapter feature through the public API.

| Item            | Value                                                       |
| --------------- | ----------------------------------------------------------- |
| Versions tested | **16.14**, **17.10**, **18.4** (latest patch of each major) |
| Driver          | `jsr:@db/postgres@0.19.5`                                   |
| Suite           | `integration/pg_features_test.ts` (31 tests)                |
| Runner          | `docker/Dockerfile` + `docker/compose.yaml`                 |
| Last run        | 2026-06-28 — **31 / 31 passed on every version**            |

## Feature coverage

Every feature across all four adapters — each ✅/⚠️ backed by a named
integration test — lives in the unified
[cross-driver feature matrix](feature-matrix.md), verified by
`deno task docs:matrix:check`. All 31 `pg:` tests pass **identically on
pg16/17/18** (`scripts/pg-matrix.sh`). Below are the PostgreSQL-specific
column-type coverage and driver-level behavior notes.

## Column types proven by the DDL test

A single table exercises every generated type; the `CREATE TABLE` is executed on
each server and the column count is verified:

`text` · `varchar(n)` · `char(n)` · `integer` · `smallint` · `bigint` · `serial`
· `bigserial` · `numeric(p,s)` · `real` · `double precision` · `boolean` ·
`json` · `jsonb` · `date` · `time` · `timestamp` · `timestamptz` · `uuid` ·
`text[]` · `bytea`.

## Behavior notes (driver-level, not version-specific)

- **`SELECT *` across joins needs distinct column names.** The `@db/postgres`
  driver maps rows into objects keyed by column name, so a `select *` over two
  tables that both expose `id`/`name` throws _"Field names … are duplicated"_.
  Use an explicit projection in joins —
  `db.select({ uid: a.columns.id, oid: b.columns.id })` — which is the
  recommended pattern anyway.
- **`numeric`/`bigint`/`bigserial` come back as strings**, and `count()`/`sum()`
  return `numeric`/`bigint` — also strings. This preserves precision; coerce
  with `Number(...)` when you want a JS number. Sisal types `numeric`/`bigint`
  as `string` for the same reason.
- **`json` vs `jsonb`.** `jsonb` round-trips as a parsed object; some `json`
  paths may return text — parse defensively if you mix them.
- **Date/time semantics.** Sisal maps SQL `date` to `Temporal.PlainDate`, `time`
  to `Temporal.PlainTime`, `timestamp` to `Temporal.PlainDateTime`, and
  `timestamptz` to `Temporal.Instant` at the type level. Result parsing is
  opt-in with `temporal: { parse: true }`; otherwise rows keep the
  `@db/postgres` driver shape. Use `mode: "date"` to keep JS `Date` values or
  `mode: "string"` to keep raw text. PostgreSQL stores timestamps at microsecond
  precision; JS `Date` stores milliseconds.
- **`timestamp` vs `timestamptz`.** `columns.timestamp()` now emits `timestamp`.
  Use `columns.timestamp({ withTimezone: true })` for `timestamptz` / instant
  semantics.
- **The typed function caller is PostgreSQL-oriented.** `db.call(fn, args)`
  renders `value::type` casts from the declared argument column types and maps a
  `RETURNS TABLE (...)` function to typed rows (a scalar return is aliased as
  `result`). The `::type` cast syntax and stored `CREATE FUNCTION` definitions
  are PostgreSQL features, so this is verified here and not on SQLite.

## Reproduce

```sh
# 1. Start PostgreSQL 16, 17, and 18
docker compose -f docker/compose.yaml up -d pg16 pg17 pg18

# 2. Run the suite against one server (host Deno)
DATABASE_URL=postgres://postgres:postgres@localhost:55418/sisal \
  deno test --allow-net --allow-env --allow-read integration/pg_features_test.ts

# …or run the whole matrix and print the per-version table:
scripts/pg-matrix.sh

# Fully in Docker, against a chosen server:
DATABASE_URL=postgres://postgres:postgres@pg18:5432/sisal \
  docker compose -f docker/compose.yaml run --rm runner
```

Ports: pg16 → `55416`, pg17 → `55417`, pg18 → `55418`.

The suite is **skipped automatically when `DATABASE_URL` is unset**, so it never
runs (or needs network) during the ordinary `deno task test`.
