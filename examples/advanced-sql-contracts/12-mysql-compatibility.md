# 12 — MySQL compatibility (graduated contract)

**Status:** graduated into runnable workspace examples. The original pressure
cases now live in `@sisal/mysql`, the mysql-family integration suite, and the
MySQL-family examples.

**Roadmap owner:**
[v0.6 Workstream C](../../docs/v0.6.0-roadmap.md#workstream-c--mysql-support-investigation)
(MySQL-readiness investigation — pin the latent `"mysql"` render path, design
the upsert/`RETURNING` divergences) →
[v0.7 Workstream B](../../docs/v0.7.0-roadmap.md) (built and shipped the
`@sisal/mysql` adapter, Sisal's fifth dialect). This contract is retained as the
historical pressure-case list the adapter and examples now satisfy.

**Related runnable examples:** [`mysql-family-basic`](../mysql-family-basic/),
[`mysql-family-showcase`](../mysql-family-showcase/), and
[`mysql-family-feed`](../mysql-family-feed/README.md). The PostgreSQL reference
stays
[`postgres-family-activity-vectors`](../postgres-family-activity-vectors/README.md)
/ [`postgres-family-feed`](../postgres-family-feed/README.md).

## Why this contract graduated

The renderer now has a tested MySQL-family adapter behind it: `@sisal/mysql`
provides the dialect identity, lazy `mysql2`/MariaDB drivers, MySQL DDL,
migrations, feature-matrix columns, and shared live integration scenarios. The
new examples keep the remaining pressure points visible instead of burying them
in implementation detail.

## Product use case

A developer points Sisal at MySQL 8 (or MariaDB) and expects the **same
builder** to work — CRUD, joins, CTEs, window functions, upsert, migrations —
with the divergences handled explicitly, not silently mis-rendered. This
contract enumerates the **pressure cases** the MySQL-family examples and feature
suite now cover.

## Pressure cases to preserve

1. **Basic CRUD parity** — `select`/`insert`/`update`/`delete` with backtick
   quoting + `?` placeholders. _Render-ready today (v0.6 C1)._
2. **CTEs** — `WITH` (non-recursive and `WITH RECURSIVE`) — MySQL 8 / MariaDB
   10.2+ ✅; MySQL 5.7 ❌ (see
   [07-recursive-comments](07-recursive-comments.md)).
3. **Window functions** — MySQL 8 ✅; 5.7 ❌ — the
   [02-window-analytics](02-window-analytics.md) /
   [04-top-n-per-group](04-top-n-per-group.md) examples become MySQL-portable on
   8+.
4. **Upsert divergence** — the biggest gap: `onConflictDoUpdate` renders
   Postgres `ON CONFLICT (…) DO UPDATE`, but MySQL needs
   `INSERT … ON DUPLICATE KEY UPDATE col = VALUES(col)` (or 8.0.20+
   `AS new … new.col`). This is now mapped by Sisal's portable `onConflict...`
   API.
5. **`RETURNING` divergence** — the renderer emits `RETURNING *` under
   `"mysql"`, but **MySQL 8 has no `RETURNING`** (MariaDB 10.5+ does). Emit on
   MariaDB, else a fetch-by-key fallback or typed guard (v0.6 C3).
6. **Type mapping** — `BOOLEAN` = `TINYINT(1)`, `JSON` (= `LONGTEXT` storage),
   `DATETIME`/`TIMESTAMP` + timezone, `DECIMAL`/`BIGINT` string-vs-number
   (mirror the pg `numeric`/float8 lessons), `BLOB` (v0.6 C4).
7. **DDL generation** — `generateMysqlUpStatements`: engine, charset/collation,
   `AUTO_INCREMENT` (vs serial), index/`CHECK` quirks, **no partial indexes**
   (see [11-generated-columns-indexes](11-generated-columns-indexes.md)).
8. **Row locking** — `FOR UPDATE` / `FOR UPDATE SKIP LOCKED` are supported (the
   `.for(...)` builder already targets MySQL alongside Postgres) — verify it
   renders and the `dialectGuard` set allows it (see
   [08-job-queue-locking](08-job-queue-locking.md)).
9. **MySQL-vs-MariaDB capability split** — `RETURNING`, sequences, JSON
   functions, recursion in older versions: one adapter with feature flags vs
   documented divergences (v0.6 C5).

## Upsert shape to preserve

```sql
-- Postgres (today)              -- MySQL (the divergence to map)
INSERT INTO t (k, v)            INSERT INTO `t` (`k`, `v`)
VALUES ($1, $2)                 VALUES (?, ?)
ON CONFLICT (k) DO UPDATE       ON DUPLICATE KEY UPDATE
  SET v = excluded.v;             `v` = VALUES(`v`);   -- or: AS new … new.v
```

## Landed Sisal primitives

- **The whole `@sisal/mysql` adapter** (`MYSQL_DIALECT`, executor, lazy driver +
  pool, errors, `migrate/`) — landed in v0.7 B.
- **Upsert mapping** — `onConflictDoUpdate` → `ON DUPLICATE KEY UPDATE`, or a
  dedicated `onDuplicateKeyUpdate` surface (answered by the v0.6 design
  decision: keep the portable `onConflict...` surface).
- **`RETURNING` strategy** — dialect/version-aware emit-or-emulate.
- **`generateMysqlUpStatements`** — additive DDL with MySQL type mapping.
- **A chosen MySQL driver** — `mysql2` by default, MariaDB Connector/Node.js as
  the lazy opt-in.

## Dialect classification (the fifth column)

| Capability       | pg/neon       | sqlite/libsql | MySQL 8                  | MariaDB            |
| ---------------- | ------------- | ------------- | ------------------------ | ------------------ |
| backtick + `?`   | n/a           | n/a           | ✅ render-ready          | ✅                 |
| upsert           | `ON CONFLICT` | `ON CONFLICT` | `ON DUPLICATE KEY` (map) | `ON DUPLICATE KEY` |
| `RETURNING`      | ✅            | ✅            | ❌ (emulate)             | ✅ (10.5+)         |
| window functions | ✅            | ✅ (modern)   | ✅ (8+)                  | ✅ (10.2+)         |
| `WITH RECURSIVE` | ✅            | ✅            | ✅ (8+) / ❌ (5.7)       | ✅ (10.2+)         |
| partial indexes  | ✅            | ✅            | ❌                       | ❌                 |
| `BOOLEAN`        | native        | 0/1           | `TINYINT(1)`             | `TINYINT(1)`       |

## Portable / emulatable / dialect-native / fail-guarded

- **Portable:** CRUD, joins, CTEs, window functions on MySQL 8 — the same
  builder, different rendering.
- **Emulatable:** `RETURNING` on MySQL 8 (`INSERT` + `SELECT` of affected keys);
  partial index (generated boolean column + full index — imperfect).
- **Dialect-native:** `ON DUPLICATE KEY UPDATE`, `AUTO_INCREMENT`, `TINYINT(1)`
  booleans — MySQL-native, mapped by the adapter.
- **Fail guarded → feature-matrix:** the v0.7 deliverable is now a test-backed
  MySQL/MariaDB pair of columns in
  [`docs/feature-matrix.md`](../../docs/feature-matrix.md): `RETURNING` on MySQL
  8 and partial indexes are `❌`, the upsert/`TINYINT`/JSON round-trips are `⚠️`
  with documented notes, the rest ✅ where live scenarios back it.

## Non-goals

Not a MySQL-specific ETL/analytics package (Postgres stays the reference); not a
promise that every PostgreSQL-only surface can be emulated.

## Verified acceptance criteria

- `@sisal/mysql` passes the shared OLTP feature suite against MySQL and MariaDB,
  gated by `SISAL_MYSQL_IT=1` / `SISAL_MARIADB_IT=1`.
- `mysql-family-basic`, `mysql-family-showcase`, and `mysql-family-feed` mirror
  the dialect-family taxonomy.
- Upsert and `RETURNING` behave correctly or fail/emulate **as documented**.
- The feature matrix has test-backed MySQL and MariaDB columns; the other four
  dialects' render output is unchanged.
