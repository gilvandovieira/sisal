---
title: PostgreSQL compatibility
---

# PostgreSQL compatibility matrix

Sisal's PostgreSQL adapter (`@sisal/pg`) is verified end-to-end against a real
server on every supported major version. The suite connects with the bundled
`jsr:@db/postgres@0.19.5` driver, applies generated DDL, and exercises every
adapter feature through the public API.

| Item            | Value                                                       |
| --------------- | ----------------------------------------------------------- |
| Versions tested | **16.14**, **17.10**, **18.4** (latest patch of each major) |
| Driver          | `jsr:@db/postgres@0.19.5`                                   |
| Suite           | `integration/pg_features_test.ts` (23 feature groups)       |
| Runner          | `docker/Dockerfile` + `docker/compose.yaml`                 |
| Last run        | 2026-06-27 — **17 / 17 passed on every version**            |

✅ = verified on a live server · 🆕 = integration test added 2026-06-28,
awaiting the next live matrix run (six new operator groups; verified by the unit
parity tests in the meantime).

## Matrix

| Feature                                                        | pg16 | pg17 | pg18 |
| -------------------------------------------------------------- | :--: | :--: | :--: |
| **Connection** — `connect({ url })`, pooled, parameterized SQL |  ✅  |  ✅  |  ✅  |
| **Generated DDL applies** — all column types below             |  ✅  |  ✅  |  ✅  |
| **Insert** — `values`, multi-row, `returning`                  |  ✅  |  ✅  |  ✅  |
| **Comparison ops** — `eq` `ne` `gt` `gte` `lt` `lte`           |  ✅  |  ✅  |  ✅  |
| **Pattern ops** — `like` `ilike` `notLike` `notIlike`          |  ✅  |  ✅  |  ✅  |
| **Range ops** — `between` `notBetween`                         |  ✅  |  ✅  |  ✅  |
| **Set ops** — `inArray` `notInArray`                           |  ✅  |  ✅  |  ✅  |
| **Null ops** — `isNull` `isNotNull`                            |  ✅  |  ✅  |  ✅  |
| **Logical** — `and` `or` `not`                                 |  ✅  |  ✅  |  ✅  |
| **Ordering** — `asc`/`desc`, multi-key, `limit`, `offset`      |  ✅  |  ✅  |  ✅  |
| **Distinct** — `select().distinct()`                           |  ✅  |  ✅  |  ✅  |
| **Joins** — `inner` / `left` / `right` / `full`                |  ✅  |  ✅  |  ✅  |
| **Aggregates** — `count` `sum` `avg` `min` `max`               |  ✅  |  ✅  |  ✅  |
| **Aggregate** — `countDistinct`; `db.$count(table, where?)`    |  🆕  |  🆕  |  🆕  |
| **Subquery** — `exists` / `notExists` (correlated)             |  🆕  |  🆕  |  🆕  |
| **Subquery** — derived `.as()`, scalar, `inArray(subquery)`    |  🆕  |  🆕  |  🆕  |
| **`distinctOn`** — `SELECT DISTINCT ON (...)`                  |  🆕  |  🆕  |  🆕  |
| **Row locking** — `.for("update"/"share")`, `skipLocked`       |  🆕  |  🆕  |  🆕  |
| **Array ops** — `arrayContains`/`Contained`/`Overlaps`         |  🆕  |  🆕  |  🆕  |
| **Group / filter** — `groupBy`, `having`                       |  ✅  |  ✅  |  ✅  |
| **Update** — `set`, `where`, `returning`, `$onUpdate`          |  ✅  |  ✅  |  ✅  |
| **Delete** — `where`, `returning`                              |  ✅  |  ✅  |  ✅  |
| **Upsert** — `onConflictDoNothing` / `onConflictDoUpdate`      |  ✅  |  ✅  |  ✅  |
| **Transactions** — commit + rollback on error                  |  ✅  |  ✅  |  ✅  |
| **JSONB** — object round-trip                                  |  ✅  |  ✅  |  ✅  |
| **Arrays** — `text[]` round-trip                               |  ✅  |  ✅  |  ✅  |
| **Binary** — `bytea` round-trip (`Uint8Array`)                 |  ✅  |  ✅  |  ✅  |
| **Migrator** — apply, plan, history table, idempotent re-run   |  ✅  |  ✅  |  ✅  |

### Column types proven by the DDL test

A single table exercises every generated type; the `CREATE TABLE` is executed on
each server and the column count is verified:

`text` · `varchar(n)` · `char(n)` · `integer` · `smallint` · `bigint` · `serial`
· `bigserial` · `numeric(p,s)` · `real` · `double precision` · `boolean` ·
`json` · `jsonb` · `date` · `timestamp` · `timestamptz` · `uuid` · `text[]` ·
`bytea`.

## Behavior notes (driver-level, not version-specific)

- **`SELECT *` across joins needs distinct column names.** The `@db/postgres`
  driver maps rows into objects keyed by column name, so a `select *` over two
  tables that both expose `id`/`name` throws _"Field names … are duplicated"_.
  Use an explicit projection in joins —
  `db.select({ uid: a.columns.id, oid:
  b.columns.id })` — which is the
  recommended pattern anyway.
- **`numeric`/`bigint`/`bigserial` come back as strings**, and `count()`/`sum()`
  return `numeric`/`bigint` — also strings. This preserves precision; coerce
  with `Number(...)` when you want a JS number. Sisal types `numeric`/`bigint`
  as `string` for the same reason.
- **`json` vs `jsonb`.** `jsonb` round-trips as a parsed object; some `json`
  paths may return text — parse defensively if you mix them.

## Reproduce

```sh
# 1. Start PostgreSQL 16, 17, and 18
docker compose -f docker/compose.yaml up -d pg16 pg17 pg18

# 2. Run the suite against one server (host Deno)
DATABASE_URL=postgres://postgres:postgres@localhost:55418/sisal \
  deno test --allow-net --allow-env --allow-read integration/pg_features_test.ts

# …or run the whole matrix and print this table:
scripts/pg-matrix.sh

# Fully in Docker, against a chosen server:
DATABASE_URL=postgres://postgres:postgres@pg18:5432/sisal \
  docker compose -f docker/compose.yaml run --rm runner
```

Ports: pg16 → `55416`, pg17 → `55417`, pg18 → `55418`.

The suite is **skipped automatically when `DATABASE_URL` is unset**, so it never
runs (or needs network) during the ordinary `deno task test`.
