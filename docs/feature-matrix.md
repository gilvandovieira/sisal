---
title: Feature matrix
---

<!-- GENERATED FILE — do not edit by hand.
     Source of truth: tools/feature_matrix.ts
     Regenerate: deno task docs:matrix   ·   Verify: deno task docs:matrix:check -->

# Cross-driver feature matrix

One row per feature, one column per adapter, across `@sisal/pg`,
`@sisal/neon`, `@sisal/sqlite`, and `@sisal/libsql`. Every ✅ and ⚠️ is
backed by a named integration test in
`integration/<adapter>_features_test.ts` — `deno task docs:matrix:check`
fails if a claimed test is missing, so this table cannot drift from the suites.

**Legend.** ✅ tested · ⚠️ works, with a documented round-trip difference · ❌
genuine dialect limit · — not applicable.

| Feature                                                         | Postgres | Neon | SQLite  | libSQL         |
| :-------------------------------------------------------------- | :------: | :--: | :-----: | :------------: |
| Connection + raw parameterized SQL                              |    ✅     |  ✅   |    ✅    |       ✅        |
| Generated DDL (all column types)                                |    ✅     |  ✅   |    ✅    |       ✅        |
| Insert / update / delete / returning                            |    ✅     |  ✅   |    ✅    |       ✅        |
| Filter / ordering / pagination                                  |    ✅     |  ✅   |    ✅    |       ✅        |
| Joins (inner / left / right / full)                             |    ✅     |  ✅   |    ✅    |       ✅        |
| Aggregates / group / having                                     |    ✅     |  ✅   |    ✅    |       ✅        |
| Conditional aggregate (`filter`)                                |    ✅     |  ✅   |    ✅    |       ✅        |
| Portable `dateTrunc` (time bucketing)                           |    ✅     |  ✅   | [⚠️ text](#round-trip-differences) |    [⚠️ text](#round-trip-differences)     |
| Interval/date math (`now`/`dateAdd`/`dateSub`/`dateBin`)        |    ✅     |  ✅   |    ✅    |       ✅        |
| Subqueries / exists / scalar                                    |    ✅     |  ✅   |    ✅    |       ✅        |
| Upsert (`onConflict…`)                                          |    ✅     |  ✅   |    ✅    |       ✅        |
| `sql` in `SET` / `VALUES` / `onConflict`                        |    ✅     |  ✅   |    ✅    |       ✅        |
| Column naming (snake_case / `.named()` / preserve)              |    ✅     |  ✅   |    ✅    |       ✅        |
| Keyset pagination (expanded + row-value)                        |    ✅     |  ✅   |    ✅    |       ✅        |
| Prepared statements                                             |    ✅     |  ✅   |    ✅    |       ✅        |
| Transactions (commit + rollback)                                |    ✅     |  ✅   |    ✅    |       ✅        |
| `db.batch` (non-interactive, atomic)                            |    ✅     |  ✅   |    ✅    |       ✅        |
| Atomic operation / transaction script (`defineAtomicOperation`) |    ✅     |  ✅   |    ✅    |       ✅        |
| Rich indexes (DESC / partial / expression)                      |    ✅     |  ✅   |    ✅    |       ✅        |
| Migrator (apply / plan / idempotent)                            |    ✅     |  ✅   |    ✅    |       ✅        |
| Stored schema objects (functions / triggers / views)            |    ✅     |  ✅   |    ✅    |       ✅        |
| Typed raw-query mapping (`db.query(...).as(table)`)             |    ✅     |  ✅   |    ✅    |       ✅        |
| Temporal date/time modes                                        |    ✅     |  ✅   |    ✅    |       ✅        |
| `ilike` / `notIlike`                                            |    ✅     |  ✅   | [⚠️ LIKE](#round-trip-differences) |    [⚠️ LIKE](#round-trip-differences)     |
| `json` / array round-trip                                       |    ✅     |  ✅   | [⚠️ text](#round-trip-differences) |    [⚠️ text](#round-trip-differences)     |
| `boolean` round-trip                                            |    ✅     |  ✅   | [⚠️ 0/1](#round-trip-differences)  |     [⚠️ 0/1](#round-trip-differences)     |
| `bytea` / BLOB round-trip                                       |    ✅     |  ✅   |    ✅    | [⚠️ ArrayBuffer](#round-trip-differences) |
| Float (`float4`/`float8`) round-trip → `number`                 |    ✅     |  ✅   |    ✅    |       ✅        |
| `distinctOn`                                                    |    ✅     |  ✅   |    [❌](#postgresql-only-limits)    |       [❌](#postgresql-only-limits)        |
| Row locking (`.for(...)`)                                       |    ✅     |  ✅   |    [❌](#postgresql-only-limits)    |       [❌](#postgresql-only-limits)        |
| Array operators (`@>` / `<@` / `&&`)                            |    ✅     |  ✅   |    [❌](#postgresql-only-limits)    |       [❌](#postgresql-only-limits)        |
| Typed function caller (`db.call`)                               |    ✅     |  ✅   |    [❌](#postgresql-only-limits)    |       [❌](#postgresql-only-limits)        |
| Data-modifying CTE (`WITH … INSERT/UPDATE/DELETE … RETURNING`)  |    ✅     |  ✅   |    [❌](#postgresql-only-limits)    |       [❌](#postgresql-only-limits)        |

The ⚠️ and ❌ cells link to the one-paragraph reason for each, below. They are
the only principled, permanent divergences — everything else behaves
identically across the four adapters.

## Round-trip differences

These ⚠️ cells work — the feature is exercised on every adapter — but a value
comes back in a different JS shape on the SQLite family than on PostgreSQL:

- **Portable `dateTrunc` (time bucketing)** — No `date_trunc`; `dateTrunc` renders via `strftime`, which returns the truncated timestamp as an ISO-8601 `TEXT` string (PostgreSQL returns a `timestamp`). Both order and group identically.
- **`ilike` / `notIlike`** — No `ILIKE` keyword in the SQLite family; `ilike`/`notIlike` render as ASCII case-insensitive `LIKE`/`NOT LIKE`.
- **`json` / array round-trip** — No `json`/array type; values auto-serialize to `TEXT` and read back as JSON strings (`JSON.parse` on read).
- **`boolean` round-trip** — No native boolean; stored as `INTEGER` `0`/`1`.
- **`bytea` / BLOB round-trip** — `@libsql/client` returns BLOBs as `ArrayBuffer` (wrap with `new Uint8Array(value)`); SQLite and Postgres return `Uint8Array`.

Value-shape summary (what a read yields, per adapter family):

| Type | `@sisal/pg` / `@sisal/neon` | `@sisal/sqlite` / `@sisal/libsql` |
| --- | --- | --- |
| `numeric` / `bigint` | string (precision-preserving) | number |
| `json` / `jsonb` / array | parsed value | JSON `TEXT` string (`JSON.parse` on read) |
| `boolean` | `boolean` | `INTEGER` `0`/`1` |
| `bytea` / BLOB | `Uint8Array` | `Uint8Array` (sqlite) · `ArrayBuffer` (libsql) |
| `real` / `double precision` (float4/float8) | number | number |

## PostgreSQL-only limits

The SQLite family has no equivalent for these PostgreSQL constructs. Rendering a
builder that uses one for a SQLite-family dialect throws a typed `OrmError`
(`ORM_DIALECT_UNSUPPORTED`) at render time (v0.5.0 item 4) — except the typed
function caller (`db.call`), which has no SQLite-family API surface at all:

- **`distinctOn`** — `DISTINCT ON` is PostgreSQL-only; SQLite-family engines reject it. Rendering it for a SQLite-family dialect throws a typed `OrmError` at render time, before execution.
- **Row locking (`.for(...)`)** — No row-level locking (`FOR UPDATE`/`FOR SHARE`) in the SQLite family. Rendering it for a SQLite-family dialect throws a typed `OrmError` at render time, before execution.
- **Array operators (`@>` / `<@` / `&&`)** — No array type or operators (`@>`/`<@`/`&&`) in the SQLite family. Rendering it for a SQLite-family dialect throws a typed `OrmError` at render time, before execution.
- **Typed function caller (`db.call`)** — No stored-function concept in the SQLite family; `defineFunction`/`db.call` target Postgres.
- **Data-modifying CTE (`WITH … INSERT/UPDATE/DELETE … RETURNING`)** — Data-modifying CTEs (`INSERT`/`UPDATE`/`DELETE` inside `WITH`) are PostgreSQL-only; the SQLite family's CTEs are `SELECT`-only. Rendering it for a SQLite-family dialect throws a typed `OrmError` at render time, before execution.

## Reproduce

Each adapter's suite is gated and run on its own (see the per-engine pages for
setup — Docker, env vars, the bundled `neon-proxy`):

```sh
deno test --env-file=.env -A integration/pg_features_test.ts
deno test --env-file=.env -A integration/neon_features_test.ts
deno test --env-file=.env -A integration/sqlite_features_test.ts
deno test --env-file=.env -A integration/libsql_features_test.ts
```

Per-engine behavior notes live on the
[Postgres](pg-compatibility.md), [Neon](neon-compatibility.md),
[SQLite](sqlite-compatibility.md), and [libSQL](libsql-compatibility.md) pages.
