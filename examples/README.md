# Sisal examples

This directory holds two kinds of thing, kept deliberately separate:

1. **Runnable examples** — real Deno workspace packages (each has a `deno.json`
   - `mod.ts`), listed in the root `deno.json` `workspace` array and
     type-checked by `deno task check`. You can run them against a real
     database.
2. **Documentation-only future contracts** — Markdown-only scaffolds that
   preserve advanced-SQL example ideas before the features they need exist. They
   are **not runnable and not part of the workspace**.

## Runnable examples

Each is a workspace package; see its own `README` (where present) and
`deno.json` tasks for how to run it.

| Example                                                                          | Engine            | What it shows                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`postgres-family-basic`](postgres-family-basic/)                                | PostgreSQL family | Minimal DDL + connect/CRUD over `@sisal/pg` (`@db/postgres` or postgres.js) or `@sisal/neon` via `SISAL_ADAPTER`. Consolidates `basic-postgres`.                                                                                                             |
| [`sqlite-family-basic`](sqlite-family-basic/)                                    | SQLite family     | Minimal DDL + connect/CRUD over embedded `@sisal/sqlite` or `@sisal/libsql` via `SISAL_ADAPTER`. Consolidates `basic-sqlite` + `basic-libsql`.                                                                                                               |
| [`mysql-family-basic`](mysql-family-basic/)                                      | MySQL family      | Minimal DDL + connect/CRUD over `@sisal/mysql` on `mysql2` or the MariaDB connector via `SISAL_ADAPTER`.                                                                                                                                                     |
| [`postgres-family-showcase`](postgres-family-showcase/)                          | PostgreSQL family | Full feature tour; generation-first, plus a live run over `pg` / `pg-postgres-js` / `neon` via `SISAL_ADAPTER`.                                                                                                                                              |
| [`sqlite-family-showcase`](sqlite-family-showcase/)                              | SQLite family     | Full feature tour, executed over embedded `@sisal/sqlite` or `@sisal/libsql` via `SISAL_ADAPTER`.                                                                                                                                                            |
| [`mysql-family-showcase`](mysql-family-showcase/)                                | MySQL family      | Generation-first MySQL/MariaDB feature tour; optional live run over `mysql2` or the MariaDB connector via `SISAL_ADAPTER`, with explicit `RETURNING`, DDL, and timestamp caveats.                                                                            |
| [`logging`](logging/)                                                            | Driverless        | Concrete `Logger` adapters for `@std/log` and Pino, using `memoryOrmDriver()` so SQL/result/bind logging can be inspected without a real database.                                                                                                           |
| [`postgres-family-advanced-sql`](postgres-family-advanced-sql/)                  | PostgreSQL family | Runnable advanced-SQL contract graduation over `@sisal/pg` / `@sisal/neon`: builder ETL + locking, raw parameterized windows, recursive CTEs, JSON-table extraction, and richer DDL pressure cases.                                                          |
| [`mysql-family-advanced-sql`](mysql-family-advanced-sql/)                        | MySQL family      | MySQL/MariaDB advanced-SQL contract graduation: builder ETL + locking, raw parameterized windows/recursive CTEs/`JSON_TABLE`, generated columns, ODKU upsert pressure cases, and typed `RETURNING` guards.                                                   |
| [`sqlite-family-advanced-sql`](sqlite-family-advanced-sql/)                      | SQLite family     | Conservative SQLite/libSQL advanced-SQL subset with capability-probed windows, recursive CTEs, CAS queue claims, `json_each`, generated columns, and explicit skipped first-pass contracts.                                                                  |
| [`postgres-family-hot-feed`](postgres-family-hot-feed/README.md)                 | PostgreSQL family | Stored, indexed `hot_score`; atomic vote; keyset — over `pg` / `pg-postgres-js` / `neon` via `SISAL_ADAPTER`.                                                                                                                                                |
| [`postgres-family-feed`](postgres-family-feed/README.md)                         | PostgreSQL family | `/rising` feed over `@sisal/pg` (`@db/postgres` or postgres.js) or `@sisal/neon` via `SISAL_ADAPTER`; two recompute strategies (DB functions + builder CTEs). Consolidates the former `postgres-rising-feed` + `neon-rising-feed` + `neon-rising-feed-ctes`. |
| [`sqlite-family-feed`](sqlite-family-feed/README.md)                             | SQLite family     | The `/rising` counterpart over `@sisal/libsql` or embedded `@sisal/sqlite` via `SISAL_ADAPTER`.                                                                                                                                                              |
| [`mysql-family-feed`](mysql-family-feed/README.md)                               | MySQL family      | The `/rising` counterpart over `@sisal/mysql` on MySQL or MariaDB via `SISAL_ADAPTER`; TypeScript and builder-CTE recompute paths expose MySQL/MariaDB v0.8 IR pressure points.                                                                              |
| [`postgres-family-activity-vectors`](postgres-family-activity-vectors/README.md) | PostgreSQL family | Advanced-SQL analytics: events → buckets → stats → activity vector + similarity (the v0.6 ETL-readiness PoC); over `pg` / `pg-postgres-js` / `neon`.                                                                                                         |

These are the source of truth for "what Sisal can do today." If you change one,
keep it runnable and keep its row in the root `deno.json` workspace.

## Documentation-only future contracts

[`advanced-sql-contracts/`](advanced-sql-contracts/README.md) — Markdown specs,
not runnable themselves and not in the workspace. Their first runnable
graduation is now the `*-family-advanced-sql` trio above. The specs still
preserve the original product-shaped target and map each missing primitive to
the roadmap release that must build it properly.

They exist so future planning can point at a concrete, product-shaped target
without pretending the feature already ships. When one becomes buildable, it
graduates into a real runnable example here (with its own `deno.json` +
`mod.ts`, added to the workspace) — at which point its contract becomes the
example's spec. Genuine per-dialect limits surfaced by a contract are tracked,
when the feature lands, as `❌` rows in
[`docs/feature-matrix.md`](../docs/feature-matrix.md).

> **Not part of `deno task check`.** `advanced-sql-contracts/` has no `mod.ts`
> and is intentionally excluded from the root workspace, so adding contracts
> never touches the type-check or test surface.
