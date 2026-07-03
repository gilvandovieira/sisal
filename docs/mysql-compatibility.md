---
title: MySQL / MariaDB compatibility
---

# MySQL / MariaDB compatibility

Sisal's MySQL adapter (`@sisal/mysql`) is verified end-to-end against real
servers — **both** MySQL proper and MariaDB, which share one adapter but are
distinct capability profiles. Each suite opens a pool with the default `mysql2`
driver, applies generated DDL, and exercises every adapter feature through the
public API.

| Item          | MySQL                                 | MariaDB                                  |
| ------------- | ------------------------------------- | ---------------------------------------- |
| Engine tested | **MySQL 8.4.10** (Docker `mysql:8.4`) | **MariaDB 11.8.8** (Docker `mariadb:11`) |
| Suite         | `integration/mysql_features_test.ts`  | `integration/mariadb_features_test.ts`   |
| Scenarios     | 42 shared mysql-family scenarios      | the same 42, run against MariaDB         |
| Last run      | 2026-07-01 — **42 / 42 passed**       | 2026-07-01 — **42 / 42 passed**          |

Both suites also pass live against the opt-in MariaDB Connector/Node.js driver
(`connect({ driver: "mariadb" })`); the default is `mysql2`.

## Runnable examples

- [`examples/mysql-family-basic`](../examples/mysql-family-basic/) — minimal
  DDL + connect/CRUD over `mysql2` or the MariaDB connector.
- [`examples/mysql-family-showcase`](../examples/mysql-family-showcase/) —
  generation-first feature tour with an optional live run, including DDL,
  upsert, `insertReturning`, ETL rollup SQL, and guarded `RETURNING` behavior.
- [`examples/mysql-family-feed`](../examples/mysql-family-feed/) — the `/rising`
  feed counterpart with MySQL-safe `DATETIME(6)` strings, row-value keyset
  pagination, TypeScript and CTE recompute strategies, and gated live
  MySQL/MariaDB tests.

## One adapter, two capability profiles

MySQL and MariaDB run the _same_ scenario list. The differences are pinned by
each scenario branching on the target's declared capabilities, so a divergence
is a tested fact, not a footnote:

| Capability           | MySQL 8.4              | MariaDB 11.8                                           |
| -------------------- | ---------------------- | ------------------------------------------------------ |
| `INSERT … RETURNING` | **none** (typed guard) | **lit** (auto-detected identity; floor 10.5)           |
| `DELETE … RETURNING` | **none** (typed guard) | **lit** (floor 10.0.5)                                 |
| `UPDATE … RETURNING` | none (typed guard)     | none (typed guard; MariaDB floor is 13.0)              |
| `WITH` on mutations  | **works** (MySQL 8+)   | **none** (typed guard; `WITH` parses on `SELECT` only) |
| `JSON` decode        | parsed object/array    | **JSON string** (`JSON` is a `LONGTEXT` alias)         |

The adapter's `dialectIdentity` (`{ dialect: "mysql", variant?, version? }`) is
filled at `connect()` time from one `select version()`, so the version floors
above are enforced by the core render guard — the adapter never duplicates them.

## Feature coverage

Every feature across all six adapter columns — each ✅/⚠️ backed by a named
integration test — lives in the unified
[cross-driver feature matrix](feature-matrix.md), verified by
`deno task docs:matrix:check`. The MySQL-specific type mapping and behavior
notes are below.

**v0.9 additions.** The portable ETL substrate runs on the MySQL family: the
lock-row advisory lock (`db.tryAdvisoryLock`), `etlCheckpoint`
(watermark/retention), and the `tryInsert` write-outcome — which on this family
reads the affected-row count (no usable `RETURNING` on the portable no-op
`ON DUPLICATE KEY UPDATE`) rather than `RETURNING`. Read and `WITH RECURSIVE`
CTEs have per-engine coverage (recursive needs **MySQL 8.0+ / MariaDB**);
data-modifying CTEs are guarded off (PostgreSQL-only). All are in the
[feature matrix](feature-matrix.md).

**Affected-row semantics — found-rows disabled.** The bundled `@sisal/mysql`
pools connect with `CLIENT_FOUND_ROWS` **off** (mysql2 `flags: ["-FOUND_ROWS"]`,
MariaDB connector `foundRows: false`). This is required for `tryInsert` and the
advisory-lock claim to distinguish an insert from a conflicting no-op upsert —
with found-rows on, both report one affected row, which double-grants the lock
([SEC-008](security.md#sec-008)). The one visible consequence: a plain `UPDATE`
that sets a row to the value it already holds reports **0** affected rows (rows
_changed_), where PostgreSQL and SQLite report the number of rows _matched_. If
you rely on matched-row counts on the MySQL family, compare against the row
before writing, or inject your own pool (Sisal does not force found-rows off on
an injected `pool`/`client`, so an injected pool that leaves it on will make
`tryInsert` unreliable — the advisory lock stays correct regardless, because it
verifies ownership by reading the row back).

## Column types via the DDL test

Every generated type is executed live via `generateMysqlUpStatements`
(probe-verified in the v0.6 C4 report,
[mysql type & DDL mapping](mysql-ddl-mapping.md)):

| Sisal column                  | MySQL DDL                              |
| ----------------------------- | -------------------------------------- |
| `integer` `smallint` `bigint` | `INT` `SMALLINT` `BIGINT`              |
| `serial` `bigserial`          | `INT`/`BIGINT NOT NULL AUTO_INCREMENT` |
| `numeric(p,s)` / `decimal`    | `DECIMAL(p,s)`                         |
| `real`                        | `FLOAT`                                |
| `double` / `float` / `number` | `DOUBLE`                               |
| `boolean`                     | `BOOLEAN` (stored `TINYINT(1)`)        |
| `text`                        | `TEXT`                                 |
| `varchar(n)` / `char(n)`      | `VARCHAR(n)` (255 default) / `CHAR(n)` |
| `uuid`                        | `CHAR(36)`                             |
| `json` / `jsonb` / `.array()` | `JSON`                                 |
| `date` / `time`               | `DATE` / `TIME(6)`                     |
| `timestamp`                   | `DATETIME(6)`                          |
| `timestamptz`                 | `TIMESTAMP(6) NULL`                    |
| `bytea` / `blob`              | `LONGBLOB`                             |

**Version floor:** MySQL ≥ 8.0.16, MariaDB ≥ 10.10. Three DDL rules fail closed
at generation time with a typed `OrmError` rather than shipping SQL one engine
rejects: an `AUTO_INCREMENT` column must lead a key (at most one per table,
never via `ADD COLUMN`); a `TEXT`/`BLOB`/`JSON`-mapped column cannot be a key
(use `varchar(n)`); partial (`WHERE`) and expression (functional) indexes are
refused.

## Behavior notes (MySQL/MariaDB vs PostgreSQL)

> The cross-driver round-trip differences and PostgreSQL-only limits are
> documented once in the
> [feature-matrix reference](feature-matrix.md#round-trip-differences); the
> notes below add MySQL-specific detail.

- **`RETURNING` is uneven — the adapter answers it in the executor.** MySQL 8/9
  has no `RETURNING`; `.returning()` throws a typed `OrmError` at render time.
  The `insertReturning(db, table, values)` helper answers the common "give me
  the rows I just inserted" case with the best strategy the connected server
  supports: real `INSERT … RETURNING` on MariaDB, a transactional fetch-by-key
  fallback on MySQL (one `INSERT` per row capturing each statement's own
  `LAST_INSERT_ID` — no first-id-plus-offset arithmetic, which MySQL 8.4's
  default `innodb_autoinc_lock_mode = 2` makes unsafe). It refuses typed for
  cases it cannot answer honestly (no primary key, a partial composite key, a
  `Sql`-expression key, or a DB-generated non-`AUTO_INCREMENT` key like
  `DEFAULT (uuid())`).
- **`ilike` / `notIlike` degrade to `LIKE` / `NOT LIKE`.** MySQL/MariaDB have no
  `ILIKE` keyword, so Sisal renders `LIKE`, which the default `utf8mb4`
  collations already compare case-insensitively.
- **Binary** (`columns.bytea()` → `LONGBLOB`) round-trips as `Uint8Array`. Both
  drivers decode BLOBs to Node `Buffer`s; the adapter re-views them as plain
  `Uint8Array`s (a view, no copy) to match the other adapters — and re-views
  binary _params_ as `Buffer`s before handing them to the MariaDB connector,
  which otherwise JSON-serializes a plain `Uint8Array` (a live-probe catch, B4).
- **JSON and arrays map to `JSON`, but read back differently per engine.** On
  MySQL proper the driver parses `JSON` columns back to objects/arrays; on
  MariaDB `JSON` is a `LONGTEXT` alias, so values read back as **strings**
  (`JSON.parse` on read) — the same shape as the SQLite family. Objects and
  arrays are auto-serialized to JSON text on insert.
- **Date/time values are read as text.** The pool sets `dateStrings: true`, so
  `date`/`time`/`timestamp`/`timestamptz` come back as the server's literal text
  (never a client-local `Date`, which would silently timezone-shift). Enable
  `temporal: { parse: true }` on the facade to decode ORM-built result columns
  into `Temporal` values; raw SQL rows are untouched. **Instants** are written
  as **naive UTC** literals (MySQL rejects a trailing `Z`/offset in a datetime
  literal) — the "executor UTC convention"; a `mode: "string"` instant column
  must therefore be given a MySQL-valid literal (no `Z`).
- **Booleans are `TINYINT(1)` `0`/`1`.** MySQL/MariaDB have no boolean type;
  `BOOLEAN` is an alias. Values round-trip as `0`/`1` (matching the SQLite
  family). No auto-decode: a `TINYINT(1)` display width does not guarantee
  boolean semantics.
- **`numeric`/`bigint` are precision-preserving strings** — the pool sets the
  mandated `supportBigNumbers` + `bigNumberStrings` (the C6 survey found
  mysql2's default `BIGINT` decode silently truncates past 2⁵³). This matches
  the PostgreSQL family, and diverges from the SQLite family (which returns
  numbers). Normalize ids across adapters with `String(...)`.
- **`FULL JOIN` throws a typed error.** MySQL/MariaDB have no `FULL JOIN`;
  `INNER`/`LEFT`/`RIGHT` joins all work.
- **Mutation joins work through MySQL's multi-table forms.** The portable
  builders stay the same — `update(t).from(source)` and
  `delete(t).using(source)` — while the MySQL-family renderer maps them to
  `UPDATE t, source SET t.col = … WHERE …` and
  `DELETE FROM t USING t, source WHERE …`. `INSERT … SELECT` works too.
  Combining the multi-table mutation forms with `.returning()` remains a typed
  guard, even on MariaDB, because the proven B7 `RETURNING` support is
  per-statement and single-table. On MariaDB, a `SELECT` CTE prefixed to a
  mutation (`db.with(cte).update(…)` / `.delete(…)` / `.insert(…)`) is also a
  typed guard — MariaDB parses `WITH` only on `SELECT` (verified on 11.8.8) — so
  feed a mutation join from a derived-table subquery
  (`db.select(…).as("alias")`) instead; `WITH … SELECT` works normally.
- **Row locking works.** `.for("update" | "share")` renders natively (unlike the
  SQLite family).
- **Migrations use `GET_LOCK`/`RELEASE_LOCK` named locks** — the
  `pg_advisory_lock` analogue — held on a pinned connection (MySQL named locks
  are connection-scoped). `useTransaction` defaults to **`false`**: MySQL/
  MariaDB DDL implicitly commits, so wrapping schema migrations in a transaction
  is a false promise.
- **Postgres-only constructs throw a typed error here.** `.distinctOn(...)`, the
  array operators, data-modifying CTEs, and the typed function caller
  (`db.call`) are PostgreSQL-only; using one against MySQL throws an `OrmError`
  at render time (v0.5.0 item 4). See the
  [PostgreSQL-only limits](feature-matrix.md#postgresql-only-limits) reference.

## Reproduce

```sh
docker run -d --rm --name sisal-mysql84 -e MYSQL_ROOT_PASSWORD=root \
  -e MYSQL_DATABASE=sisal -p 33084:3306 mysql:8.4
docker run -d --rm --name sisal-mariadb11 -e MARIADB_ROOT_PASSWORD=root \
  -e MARIADB_DATABASE=sisal -p 33110:3306 mariadb:11

SISAL_MYSQL_IT=1 MYSQL_URL=mysql://root:root@localhost:33084/sisal \
  deno test -A integration/mysql_features_test.ts
SISAL_MARIADB_IT=1 MARIADB_URL=mysql://root:root@localhost:33110/sisal \
  deno test -A integration/mariadb_features_test.ts
```

Each suite is **skipped unless its `SISAL_MYSQL_IT=1` / `SISAL_MARIADB_IT=1`
gate is set**, so neither runs (or needs the network) during the ordinary
`deno task test`.
