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

| Feature                                            | Postgres | Neon | SQLite  | libSQL         |
| :------------------------------------------------- | :------: | :--: | :-----: | :------------: |
| Connection + raw parameterized SQL                 |    ✅     |  ✅   |    ✅    |       ✅        |
| Generated DDL (all column types)                   |    ✅     |  ✅   |    ✅    |       ✅        |
| Insert / update / delete / returning               |    ✅     |  ✅   |    ✅    |       ✅        |
| Filter / ordering / pagination                     |    ✅     |  ✅   |    ✅    |       ✅        |
| Joins (inner / left / right / full)                |    ✅     |  ✅   |    ✅    |       ✅        |
| Aggregates / group / having                        |    ✅     |  ✅   |    ✅    |       ✅        |
| Subqueries / exists / scalar                       |    ✅     |  ✅   |    ✅    |       ✅        |
| Upsert (`onConflict…`)                             |    ✅     |  ✅   |    ✅    |       ✅        |
| `sql` in `SET` / `VALUES` / `onConflict`           |    ✅     |  ✅   |    ✅    |       ✅        |
| Column naming (snake_case / `.named()` / preserve) |    ✅     |  ✅   |    ✅    |       ✅        |
| Keyset pagination (expanded + row-value)           |    ✅     |  ✅   |    ✅    |       ✅        |
| Prepared statements                                |    ✅     |  ✅   |    ✅    |       ✅        |
| Transactions (commit + rollback)                   |    ✅     |  ✅   |    ✅    |       ✅        |
| `db.batch` (non-interactive, atomic)               |    ✅     |  ✅   |    ✅    |       ✅        |
| Rich indexes (DESC / partial / expression)         |    ✅     |  ✅   |    ✅    |       ✅        |
| Migrator (apply / plan / idempotent)               |    ✅     |  ✅   |    ✅    |       ✅        |
| Temporal date/time modes                           |    ✅     |  ✅   |    ✅    |       ✅        |
| `ilike` / `notIlike`                               |    ✅     |  ✅   | ⚠️ LIKE |    ⚠️ LIKE     |
| `json` / array round-trip                          |    ✅     |  ✅   | ⚠️ text |    ⚠️ text     |
| `boolean` round-trip                               |    ✅     |  ✅   | ⚠️ 0/1  |     ⚠️ 0/1     |
| `bytea` / BLOB round-trip                          |    ✅     |  ✅   |    ✅    | ⚠️ ArrayBuffer |
| `distinctOn`                                       |    ✅     |  ✅   |    ❌    |       ❌        |
| Row locking (`.for(...)`)                          |    ✅     |  ✅   |    ❌    |       ❌        |
| Array operators (`@>` / `<@` / `&&`)               |    ✅     |  ✅   |    ❌    |       ❌        |
| Typed function caller (`db.call`)                  |    ✅     |  ✅   |    ❌    |       ❌        |

## Notes

The ⚠️ and ❌ cells above are the principled, permanent divergences — the
SQLite family (`@sisal/sqlite`, `@sisal/libsql`) has no equivalent for the
PostgreSQL-only constructs, and stores a few types differently:

- **`ilike` / `notIlike`** — No `ILIKE` keyword in the SQLite family; `ilike`/`notIlike` render as ASCII case-insensitive `LIKE`/`NOT LIKE`.
- **`json` / array round-trip** — No `json`/array type; values auto-serialize to `TEXT` and read back as JSON strings (`JSON.parse` on read).
- **`boolean` round-trip** — No native boolean; stored as `INTEGER` `0`/`1`.
- **`bytea` / BLOB round-trip** — `@libsql/client` returns BLOBs as `ArrayBuffer` (wrap with `new Uint8Array(value)`); SQLite and Postgres return `Uint8Array`.
- **`distinctOn`** — `DISTINCT ON` is PostgreSQL-only; SQLite-family engines reject it.
- **Row locking (`.for(...)`)** — No row-level locking (`FOR UPDATE`/`FOR SHARE`) in the SQLite family.
- **Array operators (`@>` / `<@` / `&&`)** — No array type or operators (`@>`/`<@`/`&&`) in the SQLite family.
- **Typed function caller (`db.call`)** — No stored-function concept in the SQLite family; `defineFunction`/`db.call` target Postgres.

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
