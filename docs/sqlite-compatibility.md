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
| Suite         | `integration/sqlite_features_test.ts` (30 tests)     |
| Last run      | 2026-06-28 — **30 / 30 passed**                      |

✅ = verified · ⚠️ = works with a documented behavior difference · ❌ =
unsupported on SQLite.

## Matrix

| Feature                                                                 | SQLite 3.46 |
| ----------------------------------------------------------------------- | :---------: |
| **Connection** — `connect({ path })`, parameterized SQL                 |     ✅      |
| **Generated DDL applies** — affinity mapping of all types               |     ✅      |
| **Temporal date/time modes** — parse opt-in, strings, legacy Date modes |     ✅      |
| **Insert** — `values`, multi-row, `returning`                           |     ✅      |
| **Comparison** — `eq` `ne` `gt` `gte` `lt` `lte`                        |     ✅      |
| **Pattern** — `like` / `notLike`                                        |     ✅      |
| **Pattern** — `ilike` / `notIlike` (degrades to `LIKE`)                 |     ✅      |
| **Range** — `between` / `notBetween`                                    |     ✅      |
| **Set** — `inArray` / `notInArray`                                      |     ✅      |
| **Null** — `isNull` / `isNotNull`                                       |     ✅      |
| **Logical** — `and` `or` `not`                                          |     ✅      |
| **Ordering** — `asc`/`desc`, multi-key, `limit`, `offset`               |     ✅      |
| **Distinct**                                                            |     ✅      |
| **Joins** — `inner` / `left`                                            |     ✅      |
| **Joins** — `right` / `full` (SQLite ≥ 3.39)                            |     ✅      |
| **Aggregates** — `count` `sum` `avg` `min` `max`                        |     ✅      |
| **Aggregate** — `countDistinct`; `db.$count(table, where?)`             |     ✅      |
| **Subquery** — `exists` / `notExists` (correlated)                      |     ✅      |
| **Subquery** — derived table `.as()`, scalar, `inArray(subquery)`       |     ✅      |
| **Group / filter** — `groupBy`, `having`                                |     ✅      |
| **Update** — `set`, `where`, `returning`, `$onUpdate`                   |     ✅      |
| **Delete** — `where`, `returning`                                       |     ✅      |
| **Upsert** — `onConflictDoNothing` / `onConflictDoUpdate`               |     ✅      |
| **`sql` in `.set()` / `.values()` / `onConflict`** (inline expressions) |     ✅      |
| **Column naming** — snake_case default, `.named()`, `preserve`          |     ✅      |
| **Keyset pagination** — `.keyset({ orderBy, after })`, both forms       |     ✅      |
| **Prepared statements** — `placeholder()` + `.prepare()`                |     ✅      |
| **Transactions** — commit + rollback, single-connection serialized      |     ✅      |
| **Batch** — `db.batch([...])` non-interactive, atomic                   |     ✅      |
| **Boolean** — round-trip                                                |     ⚠️      |
| **JSON / JSONB** — object round-trip                                    |     ⚠️      |
| **Arrays** — `text[]` round-trip                                        |     ⚠️      |
| **Binary** — `bytea`/`BLOB` round-trip (`Uint8Array`)                   |     ✅      |
| **Migrator** — apply, plan, history table, idempotent re-run            |     ✅      |

### Column types via the DDL test

Every generated type maps onto one of SQLite's five affinities and the
`CREATE TABLE` is executed live:

| Sisal column                                                                          | SQLite affinity |
| ------------------------------------------------------------------------------------- | --------------- |
| `integer` `smallint` `bigint` `serial` `bigserial` `boolean`                          | `INTEGER`       |
| `numeric` `real` `doublePrecision` `number`                                           | `REAL`          |
| `text` `varchar` `char` `uuid` `date` `time` `timestamp` `timestamptz` `json` `jsonb` | `TEXT`          |
| `bytea` / `blob`                                                                      | `BLOB`          |

## Behavior notes (SQLite vs PostgreSQL)

- **`ilike` / `notIlike` degrade to `LIKE` / `NOT LIKE`.** SQLite has no `ILIKE`
  keyword, so Sisal renders these as `LIKE`, which is already case-insensitive
  for ASCII. Folding is ASCII-only (not full Unicode like Postgres `ILIKE`).
- **Binary** (`columns.bytea()` → `BLOB`) round-trips as `Uint8Array`.
- **JSON and arrays round-trip as text.** Objects and arrays are auto-serialized
  to a JSON `TEXT` value on insert (`{"note":"x"}`, `["a","b"]`) and come back
  as a **string** — `JSON.parse` on read. PostgreSQL `jsonb`/arrays return
  already parsed values. ⚠️ marks this difference, not a failure.
- **Date/time values are `TEXT`.** SQLite has no native date/time storage class,
  so `date`, `time`, `timestamp`, and `timestamptz` store ISO text. Temporal
  params are normalized to strings before execution. Enable
  `temporal: { parse: true }` on the database facade to decode known ORM-built
  result columns back into `Temporal.PlainDate`, `Temporal.PlainTime`,
  `Temporal.PlainDateTime`, or `Temporal.Instant`; raw SQL rows are untouched.
  ISO text sorts lexicographically when all values use a consistent format.
- **Booleans are `INTEGER` `0`/`1`.** SQLite has no boolean type; values
  round-trip as `0`/`1` numbers. Coerce with `Boolean(Number(x))`.
- **`numeric`/`bigint` are not precision-preserving.** They map to `REAL`/
  `INTEGER` affinity and return as JS numbers (PostgreSQL returns strings to
  keep precision).
- **`serial`/`bigserial` are not auto-increment here.** They map to `INTEGER`
  under a table-level `PRIMARY KEY`, which is not SQLite's rowid alias — provide
  ids yourself, or use a single `INTEGER PRIMARY KEY` column for rowid behavior.
- **`right`/`full` joins need SQLite ≥ 3.39** (the bundled engine is 3.46).
- **Column naming and keyset pagination behave identically to PostgreSQL.**
  camelCase keys map to snake_case columns (or `.named()`/`preserve`), and
  `.keyset(...)` returns `{ rows, nextCursor }` for both predicate forms — the
  `"row-value"` `(a, b) < (x, y)` comparison uses SQLite row values (≥ 3.15).
  Functions are **not** covered here: SQLite has no `CREATE FUNCTION` and no
  PostgreSQL `value::type` cast syntax, so `db.call(...)` targets PostgreSQL.
- **Postgres-only operators are not available here.** `.distinctOn(...)`,
  `.for("update" | "share")` row locking, and the array operators
  (`arrayContains`/`arrayContained`/`arrayOverlaps`) target PostgreSQL; SQLite
  has no equivalent.

## Reproduce

```sh
SISAL_SQLITE_IT=1 deno test --allow-ffi --allow-read --allow-write \
  --allow-env --allow-net integration/sqlite_features_test.ts
```

No server or Docker is required — SQLite is embedded. The suite is **skipped
unless `SISAL_SQLITE_IT=1`**, so it never runs (or needs FFI) during the
ordinary `deno task test`.
