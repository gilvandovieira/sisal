# 12 — MySQL compatibility (documentation-only future contract)

**Status:** documentation-only future contract. Not runnable; not in the
workspace. **No `@sisal/mysql` package exists** (and none is created here).

**Roadmap owner:**
[v0.6 Workstream C](../../docs/v0.6.0-roadmap.md#workstream-c--mysql-support-investigation)
(MySQL-readiness investigation — pin the latent `"mysql"` render path, design
the upsert/`RETURNING` divergences) →
[v0.7 Workstream B](../../docs/v0.7.0-roadmap.md) (builds and ships the
`@sisal/mysql` adapter, Sisal's fifth dialect). This contract is the **example
pressure-case list** the adapter must satisfy.

**Related runnable examples:** the future `examples/basic-mysql` (v0.7 required
example) and every contract in this directory tagged "future MySQL" — this file
is their MySQL-specific cross-cut. The Postgres reference stays
[`neon-activity-vectors`](../neon-activity-vectors/README.md) /
[`postgres-family-feed`](../postgres-family-feed/README.md).

## Why MySQL is latent, not absent

The renderer already half-knows MySQL: `SqlDialect` includes `"mysql"`,
identifiers quote with **backticks**, placeholders fall through to `?`, and
`ilike` degrades to `LIKE` (per [v0.6 C1](../../docs/v0.6.0-roadmap.md), all
render-tested). What is **absent** is everything an adapter needs — no
`MYSQL_DIALECT`, no executor/driver/pool, no `generateMysqlUpStatements`, no
type mapping, no integration suite, no matrix column.

## Product use case

A developer points Sisal at MySQL 8 (or MariaDB) and expects the **same
builder** to work — CRUD, joins, CTEs, window functions, upsert, migrations —
with the divergences handled explicitly, not silently mis-rendered. This
contract enumerates the **pressure cases** a `basic-mysql` + a feature suite
must cover.

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
   `AS new … new.col`). **Renders wrong under `"mysql"` today** (v0.6 C2).
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

## Required future Sisal primitives

- **The whole `@sisal/mysql` adapter** (`MYSQL_DIALECT`, executor, lazy driver +
  pool, errors, `migrate/`) — v0.7 B. **Absent.**
- **Upsert mapping** — `onConflictDoUpdate` → `ON DUPLICATE KEY UPDATE`, or a
  dedicated `onDuplicateKeyUpdate` surface (the v0.6 design decision).
- **`RETURNING` strategy** — dialect/version-aware emit-or-emulate.
- **`generateMysqlUpStatements`** — additive DDL with MySQL type mapping.
- **A chosen MySQL driver** (Deno + Node, per the v0.6 Node/npm workstream).

## Dialect classification (the fifth column)

| Capability       | pg/neon       | sqlite/libsql | future MySQL 8           | future MariaDB     |
| ---------------- | ------------- | ------------- | ------------------------ | ------------------ |
| backtick + `?`   | n/a           | n/a           | ✅ render-ready          | ✅                 |
| upsert           | `ON CONFLICT` | `ON CONFLICT` | `ON DUPLICATE KEY` (map) | `ON DUPLICATE KEY` |
| `RETURNING`      | ✅            | ✅            | ❌ (emulate)             | ✅ (10.5+)         |
| window functions | ✅            | ✅ (modern)   | ✅ (8+)                  | ✅ (10.2+)         |
| `WITH RECURSIVE` | ✅            | ✅            | ✅ (8+) / ❌ (5.7)       | ✅ (10.2+)         |
| partial indexes  | ✅            | ✅            | ❌                       | ❌                 |
| `BOOLEAN`        | native        | 0/1           | `TINYINT(1)`             | `TINYINT(1)`       |

## Portable / emulatable / dialect-native / fail-guarded

- **Portable (once the adapter exists):** CRUD, joins, CTEs, window functions on
  MySQL 8 — the same builder, different rendering.
- **Emulatable:** `RETURNING` on MySQL 8 (`INSERT` + `SELECT` of affected keys);
  partial index (generated boolean column + full index — imperfect).
- **Dialect-native:** `ON DUPLICATE KEY UPDATE`, `AUTO_INCREMENT`, `TINYINT(1)`
  booleans — MySQL-native, mapped by the adapter.
- **Fail guarded → feature-matrix:** the v0.7 deliverable is a **test-backed
  fifth column** in [`docs/feature-matrix.md`](../../docs/feature-matrix.md):
  `RETURNING` on MySQL 8 and partial indexes are `❌`, the upsert/`TINYINT`/JSON
  round-trips are `⚠️` with documented notes, the rest ✅. The exact embodiment
  of "if it can't be done here, the matrix tracks it."

## Non-goals

Not full MariaDB parity unless v0.6 C5 scopes it in; not a MySQL-specific
ETL/analytics surface (Postgres stays the reference); no driver dependency or
integration test added by _this_ contract (those are v0.7).

## Future acceptance criteria

- `@sisal/mysql` passes the shared OLTP feature suite against `mysql:8` (gated
  `SISAL_MYSQL_IT=1`), with a `basic-mysql` example mirroring the other
  `basic-*` examples.
- Upsert and `RETURNING` behave correctly or fail/emulate **as documented**; the
  latent `"mysql"` render path is corrected (C2/C3) before the adapter ships.
- The feature matrix gains a test-backed MySQL column; the other four dialects'
  render output is unchanged.
