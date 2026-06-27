---
title: SQLite compatibility
---

# SQLite compatibility matrix

Sisal's SQLite adapter (`@sisal/sqlite`) is verified end-to-end against a real,
embedded SQLite database. The suite opens a temp file with the bundled
`jsr:@db/sqlite` driver, applies generated DDL, and exercises every adapter
feature through the public API.

| Item          | Value                                                |
| ------------- | ---------------------------------------------------- |
| Engine tested | **SQLite 3.46.0** (bundled by `jsr:@db/sqlite@0.12`) |
| Suite         | `integration/sqlite_features_test.ts` (20 tests)     |
| Last run      | 2026-06-27 — **20 / 20 passed**                      |

✅ = verified · ⚠️ = works with a documented behavior difference · ❌ =
unsupported on SQLite.

## Matrix

| Feature                                                      | SQLite 3.46 |
| ------------------------------------------------------------ | :---------: |
| **Connection** — `connect({ path })`, parameterized SQL      |     ✅      |
| **Generated DDL applies** — affinity mapping of all types    |     ✅      |
| **Insert** — `values`, multi-row, `returning`                |     ✅      |
| **Comparison** — `eq` `ne` `gt` `gte` `lt` `lte`             |     ✅      |
| **Pattern** — `like` / `notLike`                             |     ✅      |
| **Pattern** — `ilike` / `notIlike`                           |     ❌      |
| **Range** — `between` / `notBetween`                         |     ✅      |
| **Set** — `inArray` / `notInArray`                           |     ✅      |
| **Null** — `isNull` / `isNotNull`                            |     ✅      |
| **Logical** — `and` `or` `not`                               |     ✅      |
| **Ordering** — `asc`/`desc`, multi-key, `limit`, `offset`    |     ✅      |
| **Distinct**                                                 |     ✅      |
| **Joins** — `inner` / `left`                                 |     ✅      |
| **Joins** — `right` / `full` (SQLite ≥ 3.39)                 |     ✅      |
| **Aggregates** — `count` `sum` `avg` `min` `max`             |     ✅      |
| **Group / filter** — `groupBy`, `having`                     |     ✅      |
| **Update** — `set`, `where`, `returning`, `$onUpdate`        |     ✅      |
| **Delete** — `where`, `returning`                            |     ✅      |
| **Upsert** — `onConflictDoNothing` / `onConflictDoUpdate`    |     ✅      |
| **Transactions** — commit + rollback on error                |     ✅      |
| **Boolean** — round-trip                                     |     ⚠️      |
| **JSON / JSONB** — object round-trip                         |     ⚠️      |
| **Arrays** — `text[]` round-trip                             |     ⚠️      |
| **Migrator** — apply, plan, history table, idempotent re-run |     ✅      |

### Column types via the DDL test

Every generated type maps onto one of SQLite's five affinities and the
`CREATE TABLE` is executed live:

| Sisal column                                                     | SQLite affinity |
| ---------------------------------------------------------------- | --------------- |
| `integer` `smallint` `bigint` `serial` `bigserial` `boolean`     | `INTEGER`       |
| `numeric` `real` `doublePrecision` `number`                      | `REAL`          |
| `text` `varchar` `char` `uuid` `date` `timestamp` `json` `jsonb` | `TEXT`          |
| `bytea` / `blob`                                                 | `BLOB`          |

## Behavior notes (SQLite vs PostgreSQL)

- **`ilike` / `notIlike` are unsupported.** SQLite has no `ILIKE` keyword, so
  the generated SQL is rejected. SQLite's `LIKE` is already case-insensitive for
  ASCII — use `like` / `notLike`.
- **JSON and arrays round-trip as text.** Objects and arrays are auto-serialized
  to a JSON `TEXT` value on insert (`{"note":"x"}`, `["a","b"]`) and come back
  as a **string** — `JSON.parse` on read. PostgreSQL `jsonb`/arrays return
  already parsed values. ⚠️ marks this difference, not a failure.
- **Booleans are `INTEGER` `0`/`1`.** SQLite has no boolean type; values
  round-trip as `0`/`1` numbers. Coerce with `Boolean(Number(x))`.
- **`numeric`/`bigint` are not precision-preserving.** They map to `REAL`/
  `INTEGER` affinity and return as JS numbers (PostgreSQL returns strings to
  keep precision).
- **`serial`/`bigserial` are not auto-increment here.** They map to `INTEGER`
  under a table-level `PRIMARY KEY`, which is not SQLite's rowid alias — provide
  ids yourself, or use a single `INTEGER PRIMARY KEY` column for rowid behavior.
- **`right`/`full` joins need SQLite ≥ 3.39** (the bundled engine is 3.46).

## Reproduce

```sh
SISAL_SQLITE_IT=1 deno test --allow-ffi --allow-read --allow-write \
  --allow-env --allow-net integration/sqlite_features_test.ts
```

No server or Docker is required — SQLite is embedded. The suite is **skipped
unless `SISAL_SQLITE_IT=1`**, so it never runs (or needs FFI) during the
ordinary `deno task test`.
