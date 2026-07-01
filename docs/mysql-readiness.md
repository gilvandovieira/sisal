---
title: MySQL readiness
---

# MySQL-readiness report — workstream C, complete (v0.6.0)

**Date:** 2026-07-01 · **Status:** all six C tasks 🟢 · **Verified against:**
MySQL **8.4.10** and MariaDB **11.8.8** (Docker), Deno 2.9.0 (+ Node 26
dual-runtime check)

This is the consolidated deliverable of the v0.6 MySQL Support Investigation:
what a v0.7 `@sisal/mysql` adapter requires, with **every claim executed against
both live engines** by committed probes. It aggregates and links the per-task
artifacts; the two decisions below (the variant split and the dialect identity)
are C5's output.

## Decision 1 (C5) — one adapter, MySQL-8-first; MariaDB via capability flags

**`@sisal/mysql` is one adapter.** Its baseline contract targets **MySQL ≥
8.0.16** (the C4 version floor); **MariaDB ≥ 10.10 runs on the same adapter**,
with the divergences carried by a variant-aware capability descriptor — **not**
a second `@sisal/mariadb` package, and not ad-hoc feature flags scattered
through the code.

Why, from the probe evidence:

- **The shared surface is ~95%.** Same wire protocol, same driver (`mysql2`
  connects to both — C6 benched both servers), same DDL under C4's
  strictest-common rules, same upsert rendering under C2's `VALUES()` choice,
  identical behavior for everything the [render path](#render-path) emits today.
  A second adapter would duplicate an entire adapter to vary the ~16 cells
  below.
- **The divergences are narrow, enumerable, and now pinned** — the
  [variant capability matrix](#the-variant-capability-matrix-probe-verified) is
  exhaustive over everything Sisal can express plus the known engine features,
  and each row was executed, not sourced.
- **The divergences are _capabilities_, not dialects.** MariaDB accepts the same
  SQL Sisal renders; where it differs it mostly _adds_ abilities (`RETURNING`,
  `SEQUENCE`, native `UUID`) or misses MySQL-8-only ones (`LATERAL`, `->>`,
  functional indexes, the ODKU row alias). That is precisely the shape a
  capability predicate models and a dialect fork doesn't.

Practical consequences for v0.7:

- The adapter's connect path detects the variant (`select version()` — MariaDB
  self-identifies in the version string) and fills the capability descriptor;
  the `IntegrationTarget` descriptor from the integration consolidation
  (`capabilities`/`valueShape`) is the prototype shape.
- `RETURNING` stays a typed render guard under the version-less dialect (C3);
  the adapter may later light it up for MariaDB per-statement (`INSERT`/
  `DELETE` only — `UPDATE … RETURNING` needs MariaDB 13) through the capability
  descriptor, or keep the portable fetch-by-key fallback for both.
- JSON value decoding differs **at the driver layer** (MariaDB's `JSON` is a
  `LONGTEXT` alias, so `mysql2` returns text): the executor normalizes
  (parse-on-read for JSON-typed columns, the SQLite-family precedent) so both
  variants present the same shape.

## Decision 2 — the `(engine, variant, version)` dialect identity (recorded)

The roadmap's standing open question — _is the dialect key `(engine, version)`
with MySQL/MariaDB as distinct variants, and is `dialectGuard` generalized to a
version-aware capability predicate?_ — is **decided: yes**, as the
[sequencing audit](roadmap-sequencing-audit.md) recommends, and workstream C is
the empirical forcing function:

- The same `"mysql"` SQL is valid on MariaDB but not MySQL
  (`INSERT … RETURNING`, `CREATE SEQUENCE`, `UUID` columns,
  `CREATE INDEX IF NOT EXISTS`, extended-range `TIMESTAMP`) **and** valid on
  MySQL but not MariaDB (ODKU `AS new` row alias, `LATERAL`, `->>`, functional
  indexes) — a version-less, variant-less string cannot carry that.
- **Shape:** the snapshot dialect gains an optional variant/version axis (the
  snapshot is versioned via `SCHEMA_SNAPSHOT_VERSION` and can migrate);
  `SqlDialect` (`"mysql"`) remains the render key, and `dialectGuard`
  generalizes to a version-aware capability predicate.
- **Sequencing:** implemented in **v0.7 alongside the adapter** (whose
  capability descriptor needs it first), and **before the v0.8 IR freeze** — the
  exported guard signature is the piece that cannot migrate later.

## The variant capability matrix (probe-verified)

`perf/mysql_variant_probe.ts` (`deno task perf:mysql:variant`), plus the C4 DDL
probe rows. Every cell was executed on 8.4.10 / 11.8.8:

| Capability                                | MySQL 8.4        | MariaDB 11.8                            |
| ----------------------------------------- | ---------------- | --------------------------------------- |
| `INSERT … RETURNING`                      | ✗                | ✓ (10.5+)                               |
| `DELETE … RETURNING`                      | ✗                | ✓ (10.0.5+)                             |
| `UPDATE … RETURNING`                      | ✗                | ✗ (13.0+)                               |
| ODKU `VALUES(col)` (C2's portable choice) | ✓                | ✓                                       |
| ODKU `AS new` row alias                   | ✓ (8.0.19+)      | ✗                                       |
| `FULL OUTER JOIN`                         | ✗                | ✗ → **now render-guarded**              |
| `RIGHT JOIN`                              | ✓                | ✓                                       |
| `LATERAL` derived tables                  | ✓ (8.0.14+)      | ✗                                       |
| `INTERSECT` / `EXCEPT`                    | ✓ (8.0.31+)      | ✓ (10.3+)                               |
| CTEs (`WITH … SELECT`) / window functions | ✓                | ✓                                       |
| JSON `->>` operator                       | ✓                | ✗ (`JSON_EXTRACT`/`JSON_VALUE` instead) |
| `JSON_TABLE` / `JSON_VALUE`               | ✓                | ✓                                       |
| `CREATE SEQUENCE`                         | ✗                | ✓ (10.3+)                               |
| Native `UUID` column type                 | ✗ (`CHAR(36)`)   | ✓ (10.7+)                               |
| Inline column `REFERENCES` (C4)           | silently ignored | honored                                 |
| `TEXT`/`JSON` literal defaults (C4)       | ✗                | ✓                                       |
| `CREATE INDEX IF NOT EXISTS` (C4)         | ✗                | ✓                                       |
| Functional indexes `((expr))` (C4)        | ✓ (8.0.13+)      | ✗                                       |
| `TIMESTAMP` beyond 2038 (C4)              | ✗                | ✓ (extended)                            |
| JSON decode via mysql2 (C4/C6)            | parsed           | text (`LONGTEXT` alias)                 |

## Draft fifth capability-matrix column

The MySQL column for the roadmap's pg/neon/sqlite/libsql capability matrix, each
cell classified **render-ready / typed guard / adapter work**:

| Capability                                   | mysql (prospective)                                                                                                                       |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| insert-from-select                           | ✅ render-ready (`INSERT INTO … SELECT` is native)                                                                                        |
| upsert (`onConflict*`)                       | ✅ render-ready — dialect-mapped ODKU (C2)                                                                                                |
| upsert-from-select                           | ✅ render-ready (native; no SQLite bare-parse quirk)                                                                                      |
| returning                                    | ❌ typed guard (C3); MariaDB per-statement via capability flag later                                                                      |
| filtered aggregates (`filter()`)             | ❌ typed guard (C5 — no `FILTER` on either engine, found while writing this report); the `CASE WHEN` fallback rendering is v0.7 core work |
| date bucketing (`dateTrunc`/`dateBin`/`now`) | 🔨 core variants missing — throws typed `ORM_DIALECT_UNSUPPORTED` today (pinned)                                                          |
| CTEs (`WITH`, SELECT-only)                   | ✅ engine-ready (probe) — untested through the builder                                                                                    |
| data-modifying CTEs                          | ❌ typed guard (C3 sweep) — engine has none                                                                                               |
| window functions                             | engine ✓ (probe) / no builder → v0.7 analytics                                                                                            |
| array construction / operators               | ❌ typed guard — no array type (`JSON` instead)                                                                                           |
| set-returning (`unnest`)                     | ❌ none — `JSON_TABLE` is the analogue (probe ✓ both)                                                                                     |
| `CREATE FUNCTION`                            | engine ✓ / no builder (same as pg)                                                                                                        |
| materialized views                           | ❌ none (either engine)                                                                                                                   |
| advisory locks                               | ✅ `GET_LOCK`/`RELEASE_LOCK` (C4; the A2 answer for MySQL)                                                                                |
| transactions                                 | ✅ interactive (InnoDB)                                                                                                                   |
| row locking (`.for(...)`)                    | ✅ render-ready (pinned)                                                                                                                  |
| serverless caveats                           | PlanetScale HTTP = future adapter variant (C6)                                                                                            |

Writing this classification surfaced (and fixed) **the last two wrong-SQL
renders**: `fullJoin` (no `FULL OUTER JOIN` on either engine — probe) and
`filter()` (no `FILTER (WHERE …)` clause on either engine) both rendered invalid
MySQL; both now throw typed `ORM_DIALECT_UNSUPPORTED` guards, pinned in
`packages/orm/mysql_dialect_test.ts`. The `CASE WHEN` fallback for `filter()` is
routed to v0.7 with the date-helper variants.

## The v0.7 build list (core vs adapter)

**Core (`@sisal/orm`):**

- `(engine, variant, version)` dialect axis + `dialectGuard` → capability
  predicate (decision 2).
- `mysql` variants for `dateTrunc`/`dateBin`/`dateAdd`/`dateSub`/`now`
  (`DATE_FORMAT`/`TIMESTAMPDIFF` family) and a `CASE WHEN` rendering for
  `filter()` under `mysql`.
- Optional: multi-table `UPDATE`/`DELETE` rendering to lift the C3
  `UPDATE … FROM` / `DELETE … USING` guards.

**Adapter (`@sisal/mysql`):**

- Driver: `mysql2` default with `supportBigNumbers` + `bigNumberStrings` (C6 —
  non-negotiable); `mariadb` connector as the lazy opt-in; injectable executor
  seam as in every adapter.
- Executor value normalization: JSON parse-on-read (MariaDB), `TINYINT(1)` →
  boolean decision, `Buffer` → `Uint8Array`.
- `generateMysqlUpStatements` per [`mysql-ddl-mapping.md`](mysql-ddl-mapping.md)
  (mechanical sibling of the pg generator + three generation-time validations).
- Migrator: history store + `GET_LOCK` advisory locking.
- Variant detection → capability descriptor; `sisal init` registry entry;
  `integration/_shared/mysql_family_scenarios.ts` + a `mysql` target for the
  consolidated integration suites (the `"mysql"` slot already exists).

## Render path

Where the `"mysql"` dialect stands after C1–C3 (all pinned in
`packages/orm/mysql_dialect_test.ts`): **no known construct renders wrong SQL.**
Render-ready: backtick quoting, `?` placeholders, `ilike`→`LIKE`, SELECT/INSERT,
`FOR UPDATE`, the dialect-mapped upsert + `excluded()`. Typed guards:
`RETURNING`, `UPDATE … FROM`, `DELETE … USING`, data-modifying CTEs,
`distinctOn`, array operators, `FULL JOIN` (C5), `filter()` (C5), and the
portable date helpers.

## Workstream C artifact index

| Task                         | Artifact                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| C1 render-path pins          | `packages/orm/mysql_dialect_test.ts`                                                            |
| C2 upsert design             | [v0.6.0 roadmap C2 detail](v0.6.0-roadmap.md) + `excluded()` in `@sisal/orm`                    |
| C3 `RETURNING` + guard sweep | roadmap C3 detail + the same test file                                                          |
| C4 type/DDL mapping          | [`mysql-ddl-mapping.md`](mysql-ddl-mapping.md) + `perf/mysql_ddl_probe.ts`                      |
| C5 variant split (this doc)  | `perf/mysql_variant_probe.ts`                                                                   |
| C6 driver survey             | [`perf/MYSQL_DRIVER_SURVEY.md`](../perf/MYSQL_DRIVER_SURVEY.md) + `perf/mysql_driver_survey.ts` |

## Reproduce

```sh
docker run -d --rm --name sisal-mysql84 -e MYSQL_ROOT_PASSWORD=root \
  -e MYSQL_DATABASE=sisal -p 33084:3306 mysql:8.4
docker run -d --rm --name sisal-mariadb11 -e MARIADB_ROOT_PASSWORD=root \
  -e MARIADB_DATABASE=sisal -p 33110:3306 mariadb:11

MYSQL_URL=mysql://root:root@localhost:33084/sisal deno task perf:mysql:variant
MYSQL_URL=mysql://root:root@localhost:33110/sisal \
  MYSQL_SERVER_LABEL=mariadb11 deno task perf:mysql:variant
```
