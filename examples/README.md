# Sisal examples

These examples are part of the product surface: they teach the package
architecture, adapter boundaries, the ORM/query builder, migrations, ETL,
analytics, logging, and dialect portability — honestly. Each **runnable**
example is a Deno workspace package (its own `deno.json` + `mod.ts`, listed in
the root `deno.json` workspace) and is type-checked by `deno task check`.

## How to read these examples

1. Start with **basic** — connect and do typed CRUD.
2. Move to **showcase** — the broad tour of schema + query features.
3. Read **feed** for app-style usage (keyset pagination, ranking).
4. Read **advanced SQL** for serious query shapes (windows, recursive CTEs, …).
5. Read **ETL + analytics** together — ETL builds rollups, analytics reads them.
6. Use **logging** when debugging or wiring production observability.

## Families

### Basic

The first five minutes: `defineTable`, generated DDL, and one insert → select →
update → delete cycle with bound parameters and a clean dispose path.
[`postgres-family-basic`](postgres-family-basic/) ·
[`sqlite-family-basic`](sqlite-family-basic/) ·
[`mysql-family-basic`](mysql-family-basic/)

### Showcase

The broad "what Sisal can do today" tour — types, constraints, migration diffs,
operators, joins, aggregates, upserts, transactions, relations, CTEs — with
dialect honesty (Postgres is richest; SQLite executes in-memory; MySQL shows its
gaps and typed guards). [`postgres-family-showcase`](postgres-family-showcase/)
· [`sqlite-family-showcase`](sqlite-family-showcase/) ·
[`mysql-family-showcase`](mysql-family-showcase/)

### Feed

The canonical app-style example: users/posts/activity, a `/new` and `/rising`
timeline backed by a stored ranking value, keyset (cursor) pagination, and
cursor-correctness tests. [`postgres-family-feed`](postgres-family-feed/) ·
[`sqlite-family-feed`](sqlite-family-feed/) ·
[`mysql-family-feed`](mysql-family-feed/)

### Advanced SQL

Proof that Sisal is a serious SQL builder: window functions, recursive CTEs,
top-N per group, sessionization, cohort/funnel shapes, JSON-table extraction,
row locking — builder-native where the surface exists, safe parameterized `sql`
where it doesn't.
[`postgres-family-advanced-sql`](postgres-family-advanced-sql/) ·
[`sqlite-family-advanced-sql`](sqlite-family-advanced-sql/) ·
[`mysql-family-advanced-sql`](mysql-family-advanced-sql/). The
[`advanced-sql-contracts`](advanced-sql-contracts/README.md) directory holds the
documentation-only future contracts and their v0.11 triage.

### ETL

[`postgres-family-etl-cron`](postgres-family-etl-cron/) — `@sisal/etl`: a typed
rollup job (`defineJob`) folded one checkpointed window per `run()`, scheduled
with `Deno.cron`. Folds `post_events` → `post_hourly_stats`.

### Analytics

[`postgres-family-analytics`](postgres-family-analytics/) — `@sisal/analytics`:
typed metrics × dimensions × windows (`bucket`, `movingAvg`, `rank`,
`compareToPreviousWindow`) over the **same `post_hourly_stats` rollup the ETL
example writes**. Read the two together: ETL builds the rollups; analytics reads
them.

### Logging

[`logging`](logging/) — safe observability: `@std/log` and Pino adapters, SQL
text logging, and parameter/DSN/token redaction, over `memoryOrmDriver()` so it
needs no database.

## Dialect families

### PostgreSQL family

Includes `@sisal/pg` and `@sisal/neon`. `NeonDatabase` ≡ `PgDatabase`, so one
body runs over both; pick with `SISAL_ADAPTER` (`pg` | `pg-db-postgres` |
`neon`). The **ETL, analytics, hot-feed, and activity-vectors** examples are
Postgres-only — they rely on Postgres-first surfaces (stored functions,
`FILTER`, window functions, arrays, the ETL/analytics preview packages).

### SQLite family

Includes `@sisal/sqlite` (embedded, FFI) and `@sisal/libsql` (libSQL/Turso).
`SqliteDatabase` ≡ `LibsqlDatabase`; pick with `SISAL_ADAPTER` (`sqlite` |
`libsql`). These examples run with **no server** (in-memory or a local file) but
need FFI/write permissions (`-A`).

### MySQL family

Includes `@sisal/mysql`, covering both MySQL and MariaDB via one adapter with
detected identity; pick with `SISAL_ADAPTER` (`mysql2` | `mariadb`). The live
paths need an external MySQL/MariaDB server (`docker/compose.yaml` does not
provide one).

## What each example proves

| Example                                                               | Dialect    | Runs without external DB? | Uses live DB?          | Shows migrations? | Shows ORM? | Shows ETL?      | Shows analytics? |
| --------------------------------------------------------------------- | ---------- | ------------------------- | ---------------------- | ----------------- | ---------- | --------------- | ---------------- |
| [postgres-family-basic](postgres-family-basic/)                       | PostgreSQL | ✅ prints DDL             | optional               | DDL gen           | ✅         | —               | —                |
| [sqlite-family-basic](sqlite-family-basic/)                           | SQLite     | ✅ in-memory              | ✅ (embedded)          | DDL gen           | ✅         | —               | —                |
| [mysql-family-basic](mysql-family-basic/)                             | MySQL      | ✅ prints DDL             | optional               | DDL gen           | ✅         | —               | —                |
| [postgres-family-showcase](postgres-family-showcase/)                 | PostgreSQL | ✅ generation             | optional (rolled back) | ✅ diffs          | ✅         | —               | —                |
| [sqlite-family-showcase](sqlite-family-showcase/)                     | SQLite     | ✅ executes in-memory     | ✅ (embedded)          | ✅ diffs          | ✅         | —               | —                |
| [mysql-family-showcase](mysql-family-showcase/)                       | MySQL      | ✅ generation             | optional               | ✅ diffs          | ✅         | rollup shape    | —                |
| [postgres-family-feed](postgres-family-feed/)                         | PostgreSQL | message only              | ✅ required            | ✅ SQL files      | ✅         | —               | —                |
| [sqlite-family-feed](sqlite-family-feed/)                             | SQLite     | ✅ local file             | ✅ (embedded)          | ✅ SQL file       | ✅         | —               | —                |
| [mysql-family-feed](mysql-family-feed/)                               | MySQL      | message only              | ✅ required            | ✅ SQL file       | ✅         | —               | —                |
| [postgres-family-advanced-sql](postgres-family-advanced-sql/)         | PostgreSQL | ✅ render                 | optional (rolled back) | DDL gen           | ✅         | rollup shape    | window shapes    |
| [sqlite-family-advanced-sql](sqlite-family-advanced-sql/)             | SQLite     | ✅ render + in-memory     | ✅ (embedded)          | DDL gen           | ✅         | rollup shape    | window shapes    |
| [mysql-family-advanced-sql](mysql-family-advanced-sql/)               | MySQL      | ✅ render                 | optional               | DDL gen           | ✅         | rollup shape    | window shapes    |
| [postgres-family-hot-feed](postgres-family-hot-feed/)                 | PostgreSQL | message only              | ✅ required            | schema-gen DDL    | ✅         | —               | —                |
| [postgres-family-activity-vectors](postgres-family-activity-vectors/) | PostgreSQL | ⚠️ needs DB               | ✅ required            | ✅ SQL files      | ✅         | builder rollups | feature vectors  |
| [postgres-family-etl-cron](postgres-family-etl-cron/)                 | PostgreSQL | ✅ prints rollup SQL      | optional (cron)        | DDL gen           | ✅         | ✅              | —                |
| [postgres-family-analytics](postgres-family-analytics/)               | PostgreSQL | ✅ render                 | optional               | DDL gen           | ✅         | reads rollup    | ✅               |
| [logging](logging/)                                                   | driverless | ✅ memory driver          | —                      | —                 | ✅         | —               | —                |

### How to run each

- **Dry-run / render-only (no external service):** the `basic` (DDL), `showcase`
  (generation), `advanced-sql` (render), `etl-cron`, and `analytics` examples
  all produce useful output with **no database** — `deno task run` (or
  `render`/`ddl`). `logging` runs entirely on `memoryOrmDriver()`.
- **Need `DATABASE_URL` (PostgreSQL):** the live paths of every `postgres-*`
  example, plus the feed/hot-feed/activity-vectors demos. `SISAL_ADAPTER` picks
  `pg` / `pg-db-postgres` / `neon`; `NEON_WS_PROXY` points `neon` at a local
  proxy. `postgres-family-feed` / `hot-feed` also read `DATABASE_DIRECT_URL`.
- **Need SQLite/libSQL (FFI, no server):** the `sqlite-*` examples run in-memory
  or against a local file and need `-A` (native FFI + file writes). Set
  `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` (or `SISAL_LIBSQL_URL` /
  `SISAL_SQLITE_PATH`) to target Turso or a specific path.
- **Need a MySQL/MariaDB service:** the live paths of the `mysql-*` examples
  want `MYSQL_URL` / `MARIADB_URL` (or `DATABASE_URL`). `docker/compose.yaml`
  does not currently provide these servers.
- **Postgres-only, and why:** `etl-cron`, `analytics`, `hot-feed`, and
  `activity-vectors` are PostgreSQL-family only — they depend on Postgres-first
  surfaces (the ETL/analytics preview packages, stored functions, `FILTER`,
  window functions, arrays). The feed trio, by contrast, ships one shape per
  dialect family.

Examples that need a live database and have no dry-run print a clear message
naming the required environment variable rather than crashing.

## Documentation-only future contracts

[`advanced-sql-contracts/`](advanced-sql-contracts/README.md) — Markdown specs,
**not runnable and not in the workspace**. They preserve product-shaped
advanced-SQL targets and now carry a v0.11 **triage table** mapping each
contract to its best current Sisal API (builder-native, `@sisal/etl`,
`@sisal/analytics`, or still-raw). When a contract becomes buildable it
graduates into a runnable example here.
