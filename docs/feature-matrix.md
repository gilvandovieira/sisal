---
title: Feature matrix
---

<!-- GENERATED FILE — do not edit by hand.
     Source of truth: tools/feature_matrix.ts
     Regenerate: deno task docs:matrix   ·   Verify: deno task docs:matrix:check -->

# Cross-driver feature matrix

One row per feature, one column per adapter, across `@sisal/pg`,
`@sisal/neon`, `@sisal/sqlite`, `@sisal/libsql`, and `@sisal/mysql`
(MySQL and MariaDB are distinct capability profiles of the one adapter, so
each gets a test-backed column). Every ✅ and ⚠️ is
backed by a registered shared integration scenario. The adapter entrypoints
still render those scenarios as target-prefixed Deno tests in
`integration/<adapter>_features_test.ts`; `deno task docs:matrix:check`
fails if a claimed scenario is missing, so this table cannot drift from the
suites.

**Legend.** ✅ tested · ⚠️ works, with a documented round-trip difference · ❌
genuine dialect limit · — not applicable.

| Feature                                                                  | Postgres | Neon | SQLite  | libSQL         | MySQL           | MariaDB          |
| :----------------------------------------------------------------------- | :------: | :--: | :-----: | :------------: | :-------------: | :--------------: |
| Connection + raw parameterized SQL                                       |    ✅     |  ✅   |    ✅    |       ✅        |        ✅        |        ✅         |
| Generated DDL (all column types)                                         |    ✅     |  ✅   |    ✅    |       ✅        |        ✅        |        ✅         |
| Insert / update / delete / returning                                     |    ✅     |  ✅   |    ✅    |       ✅        | [⚠️ fetch-by-key](#round-trip-differences) | [⚠️ per-statement](#round-trip-differences) |
| Filter / ordering / pagination                                           |    ✅     |  ✅   |    ✅    |       ✅        |        ✅        |        ✅         |
| Joins (inner / left / right / full)                                      |    ✅     |  ✅   |    ✅    |       ✅        |   [⚠️ no FULL](#round-trip-differences)    |    [⚠️ no FULL](#round-trip-differences)    |
| Aggregates / group / having                                              |    ✅     |  ✅   |    ✅    |       ✅        |        ✅        |        ✅         |
| Conditional aggregate (`filter`)                                         |    ✅     |  ✅   |    ✅    |       ✅        |        ✅        |        ✅         |
| Portable `dateTrunc` (time bucketing)                                    |    ✅     |  ✅   | [⚠️ text](#round-trip-differences) |    [⚠️ text](#round-trip-differences)     |     [⚠️ text](#round-trip-differences)     |     [⚠️ text](#round-trip-differences)      |
| Interval/date math (`now`/`dateAdd`/`dateSub`/`dateBin`)                 |    ✅     |  ✅   |    ✅    |       ✅        |        ✅        |        ✅         |
| Subqueries / exists / scalar                                             |    ✅     |  ✅   |    ✅    |       ✅        |        ✅        |        ✅         |
| Upsert (`onConflict…`)                                                   |    ✅     |  ✅   |    ✅    |       ✅        |        ✅        |        ✅         |
| `sql` in `SET` / `VALUES` / `onConflict`                                 |    ✅     |  ✅   |    ✅    |       ✅        |        ✅        |        ✅         |
| Column naming (snake_case / `.named()` / preserve)                       |    ✅     |  ✅   |    ✅    |       ✅        |        ✅        |        ✅         |
| Keyset pagination (expanded + row-value)                                 |    ✅     |  ✅   |    ✅    |       ✅        |        ✅        |        ✅         |
| Prepared statements                                                      |    ✅     |  ✅   |    ✅    |       ✅        |        ✅        |        ✅         |
| Transactions (commit + rollback)                                         |    ✅     |  ✅   |    ✅    |       ✅        |        ✅        |        ✅         |
| `db.batch` (non-interactive, atomic)                                     |    ✅     |  ✅   |    ✅    |       ✅        |        ✅        |        ✅         |
| Atomic operation / transaction script (`defineAtomicOperation`)          |    ✅     |  ✅   |    ✅    |       ✅        |        ✅        |        ✅         |
| Atomic op single-round-trip dispatch (CTE on PG / interactive on SQLite) |    ✅     |  ✅   |    ✅    |       ✅        |        ✅        |        ✅         |
| Rich indexes (DESC / partial / expression)                               |    ✅     |  ✅   |    ✅    |       ✅        |  [⚠️ DESC only](#round-trip-differences)   |   [⚠️ DESC only](#round-trip-differences)   |
| Migrator (apply / plan / idempotent)                                     |    ✅     |  ✅   |    ✅    |       ✅        |        ✅        |        ✅         |
| Stored schema objects (functions / triggers / views)                     |    ✅     |  ✅   |    ✅    |       ✅        |        ✅        |        ✅         |
| Typed raw-query mapping (`db.query(...).as(table)`)                      |    ✅     |  ✅   |    ✅    |       ✅        |        ✅        |        ✅         |
| Temporal date/time modes                                                 |    ✅     |  ✅   |    ✅    |       ✅        |        ✅        |        ✅         |
| `ilike` / `notIlike`                                                     |    ✅     |  ✅   | [⚠️ LIKE](#round-trip-differences) |    [⚠️ LIKE](#round-trip-differences)     |     [⚠️ LIKE](#round-trip-differences)     |     [⚠️ LIKE](#round-trip-differences)      |
| `json` / array round-trip                                                |    ✅     |  ✅   | [⚠️ text](#round-trip-differences) |    [⚠️ text](#round-trip-differences)     |     [⚠️ JSON](#round-trip-differences)     |     [⚠️ text](#round-trip-differences)      |
| `boolean` round-trip                                                     |    ✅     |  ✅   | [⚠️ 0/1](#round-trip-differences)  |     [⚠️ 0/1](#round-trip-differences)     |     [⚠️ 0/1](#round-trip-differences)      |      [⚠️ 0/1](#round-trip-differences)      |
| `bytea` / BLOB round-trip                                                |    ✅     |  ✅   |    ✅    | [⚠️ ArrayBuffer](#round-trip-differences) |        ✅        |        ✅         |
| Float (`float4`/`float8`) round-trip → `number`                          |    ✅     |  ✅   |    ✅    |       ✅        |        ✅        |        ✅         |
| `distinctOn`                                                             |    ✅     |  ✅   |    [❌](#postgresql-only-limits)    |       [❌](#postgresql-only-limits)        |        [❌](#postgresql-only-limits)        |        [❌](#postgresql-only-limits)         |
| Row locking (`.for(...)`)                                                |    ✅     |  ✅   |    [❌](#postgresql-only-limits)    |       [❌](#postgresql-only-limits)        |        ✅        |        ✅         |
| Array operators (`@>` / `<@` / `&&`)                                     |    ✅     |  ✅   |    [❌](#postgresql-only-limits)    |       [❌](#postgresql-only-limits)        |        [❌](#postgresql-only-limits)        |        [❌](#postgresql-only-limits)         |
| Typed function caller (`db.call`)                                        |    ✅     |  ✅   |    [❌](#postgresql-only-limits)    |       [❌](#postgresql-only-limits)        |        [❌](#postgresql-only-limits)        |        [❌](#postgresql-only-limits)         |
| Data-modifying CTE (`WITH … INSERT/UPDATE/DELETE … RETURNING`)           |    ✅     |  ✅   |    [❌](#postgresql-only-limits)    |       [❌](#postgresql-only-limits)        |        [❌](#postgresql-only-limits)        |        [❌](#postgresql-only-limits)         |
| Mutation joins (`UPDATE … FROM` / `INSERT … SELECT`)                     |    ✅     |  ✅   |    ✅    |       ✅        |        ✅        |        ✅         |
| ETL rollup (insert-from-select + `FILTER` + `dateTrunc` + upsert)        |    ✅     |  ✅   |    ✅    |       ✅        |        ✅        |        ✅         |
| Advisory run lock (portable lock-row lease)                              |    ✅     |  ✅   |    ✅    |       ✅        |        ✅        |        ✅         |
| Atomic load+advance (ETL checkpoint watermark)                           |    ✅     |  ✅   |    ✅    |       ✅        |        ✅        |        ✅         |
| Retention horizon + replay refusal (ETL)                                 |    ✅     |  ✅   |    ✅    |       ✅        |        ✅        |        ✅         |
| Write outcome (inserted vs conflicted/claimed)                           |    ✅     |  ✅   |    ✅    |       ✅        |        ✅        |        ✅         |
| Read CTE (WITH on SELECT)                                                |    ✅     |  ✅   |    ✅    |       ✅        |        ✅        |        ✅         |
| Recursive CTE (WITH RECURSIVE; MySQL 8+/MariaDB)                         |    ✅     |  ✅   |    ✅    |       ✅        |        ✅        |        ✅         |

The ⚠️ and ❌ cells link to the one-paragraph reason for each, below. They are
the only principled, permanent divergences — everything else behaves
identically across the six columns.

## Round-trip differences

These ⚠️ cells work — the feature is exercised on every adapter — but a value
comes back in a different JS shape (or the statement takes a documented
alternate form) off PostgreSQL:

- **Insert / update / delete / returning** — MySQL 8/9 has no `RETURNING`; `.returning()` throws a typed `OrmError` at render time. The adapter's `insertReturning()` helper answers the common case with a transactional fetch-by-key fallback (per-row `LAST_INSERT_ID`, no consecutive-id arithmetic).
- **Joins (inner / left / right / full)** — No `FULL JOIN` in MySQL/MariaDB; rendering it throws a typed `OrmError`. INNER/LEFT/RIGHT joins work.
- **Portable `dateTrunc` (time bucketing)** — No `date_trunc`; `dateTrunc` renders via `strftime`, which returns the truncated timestamp as an ISO-8601 `TEXT` string (PostgreSQL returns a `timestamp`). Both order and group identically.
- **Rich indexes (DESC / partial / expression)** — `DESC` index keys apply; partial (`WHERE`) indexes are unsupported by both engines, so the DDL generator throws a typed `OrmError`. Functional (expression) indexes are emitted on a detected base MySQL ≥ 8.0.13 and throw below that, on MariaDB (which has none — use a generated column), or when the version is unknown. Sisal emits plain `CREATE INDEX` for every dialect (no `IF NOT EXISTS`, which MySQL proper lacks).
- **`ilike` / `notIlike`** — No `ILIKE` keyword in the SQLite family; `ilike`/`notIlike` render as ASCII case-insensitive `LIKE`/`NOT LIKE`.
- **`json` / array round-trip** — No `json`/array type; values auto-serialize to `TEXT` and read back as JSON strings (`JSON.parse` on read).
- **`boolean` round-trip** — No native boolean; stored as `INTEGER` `0`/`1`.
- **`bytea` / BLOB round-trip** — `@libsql/client` returns BLOBs as `ArrayBuffer` (wrap with `new Uint8Array(value)`); SQLite and Postgres return `Uint8Array`.

Value-shape summary (what a read yields, per adapter family):

| Type | `@sisal/pg` / `@sisal/neon` | `@sisal/sqlite` / `@sisal/libsql` | `@sisal/mysql` (MySQL · MariaDB) |
| --- | --- | --- | --- |
| `numeric` / `bigint` | string (precision-preserving) | number | string (precision-preserving) |
| `json` / `jsonb` / array | parsed value | JSON `TEXT` string (`JSON.parse` on read) | parsed (MySQL) · JSON string (MariaDB) |
| `boolean` | `boolean` | `INTEGER` `0`/`1` | `TINYINT(1)` `0`/`1` |
| `bytea` / BLOB | `Uint8Array` | `Uint8Array` (sqlite) · `ArrayBuffer` (libsql) | `Uint8Array` |
| `real` / `double precision` (float4/float8) | number | number | number |
| `date` / `timestamp` / `timestamptz` text | string | string | string (naive UTC convention for instants) |

## PostgreSQL-only limits

The SQLite and MySQL families have no equivalent for these PostgreSQL
constructs. Rendering a builder that uses one for those dialects throws a typed
`OrmError` (`ORM_DIALECT_UNSUPPORTED`) at render time (v0.5.0 item 4) —
except the typed function caller (`db.call`), which has no non-Postgres API
surface at all:

- **`distinctOn`** — `DISTINCT ON` is PostgreSQL-only; the SQLite and MySQL families reject it. Rendering it for a SQLite-family or MySQL-family dialect throws a typed `OrmError` at render time, before execution.
- **Row locking (`.for(...)`)** — No row-level locking (`FOR UPDATE`/`FOR SHARE`) in the SQLite family; rendering it for a SQLite-family dialect throws a typed `OrmError` at render time, before execution. The MySQL family renders it natively.
- **Array operators (`@>` / `<@` / `&&`)** — No array type or operators (`@>`/`<@`/`&&`) in the SQLite or MySQL families. Rendering it for a SQLite-family or MySQL-family dialect throws a typed `OrmError` at render time, before execution.
- **Typed function caller (`db.call`)** — No stored-function caller off Postgres; `defineFunction`/`db.call` render PostgreSQL `SELECT * FROM fn(args)`.
- **Data-modifying CTE (`WITH … INSERT/UPDATE/DELETE … RETURNING`)** — Data-modifying CTEs (`INSERT`/`UPDATE`/`DELETE` inside `WITH`) are PostgreSQL-only; SQLite-family and MySQL-family CTEs are `SELECT`-only. Rendering it for a SQLite-family or MySQL-family dialect throws a typed `OrmError` at render time, before execution.

## Reproduce

Each adapter's suite is gated and run on its own (see the per-engine pages for
setup — Docker, env vars, the bundled `neon-proxy`):

```sh
deno test --env-file=.env -A integration/pg_features_test.ts
deno test --env-file=.env -A integration/neon_features_test.ts
deno test --env-file=.env -A integration/sqlite_features_test.ts
deno test --env-file=.env -A integration/libsql_features_test.ts
SISAL_MYSQL_IT=1 MYSQL_URL=mysql://root:root@localhost:33084/sisal \
  deno test -A integration/mysql_features_test.ts
SISAL_MARIADB_IT=1 MARIADB_URL=mysql://root:root@localhost:33110/sisal \
  deno test -A integration/mariadb_features_test.ts
```

Per-engine behavior notes live on the
[Postgres](pg-compatibility.md), [Neon](neon-compatibility.md),
[SQLite](sqlite-compatibility.md), [libSQL](libsql-compatibility.md), and
[MySQL/MariaDB](mysql-compatibility.md) pages.
