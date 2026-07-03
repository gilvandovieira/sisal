---
title: Package Architecture (long-term)
---

# Sisal package architecture — the long-term split

Sisal is, and will remain, a **Deno-first, SQL-first, type-safe** toolkit for
**relational** data access. It is not becoming an object-first ORM. As the
surface grows from OLTP query building toward ETL and analytics, the packages
stay strictly layered so the OLTP core never pays for the analytical ambitions.

This document describes the **target** package graph and the one rule that keeps
it honest. It is aspirational: most of these packages do not exist yet. The
release roadmaps (`v0.6` → `v0.11`) stage the work that gets us here. See the
[roadmap overview](roadmap.md) for sequencing.

## Workload model, not a compliance protocol

Sisal distinguishes **OLTP** (transactional, row-at-a-time, latency-sensitive
reads/writes) from **OLAP** (analytical, set-at-a-time, scan/aggregate-heavy) as
**workload models that shape an API**, not as standards to certify against. The
query builder is tuned for OLTP; ETL bridges OLTP data into OLAP-ready shapes;
analytics queries those shapes. Each is a thin, typed layer over the same core
primitives.

## The packages

| Package                           | Responsibility                                                                                                                                                                                              | Depends on                     |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **`@sisal/core`**                 | Schema primitives, the serializable snapshot, the SQL IR (`Sql`/`SqlChunk` fragments), expressions/operators, and the dialect interface + renderer. The shared substrate every other package compiles into. | —                              |
| **`@sisal/orm`**                  | The OLTP query builder: CRUD, `where`/`order`/`limit`, joins, set ops, CTEs, transactions, prepared queries, `db.batch`.                                                                                    | core                           |
| **`@sisal/migrate`**              | Snapshot diffing, migration planning/running, the `sisal` CLI.                                                                                                                                              | core (+ orm)                   |
| **`@sisal/pg`**                   | PostgreSQL adapter (dialect + executor + driver).                                                                                                                                                           | core, orm, migrate             |
| **`@sisal/neon`**                 | Neon serverless-aware PostgreSQL adapter (WebSocket Pool).                                                                                                                                                  | core, orm, migrate             |
| **`@sisal/sqlite`**               | SQLite adapter (embedded).                                                                                                                                                                                  | core, orm, migrate             |
| **`@sisal/libsql`**               | libSQL / Turso adapter (local + remote).                                                                                                                                                                    | core, orm, migrate             |
| **`@sisal/mysql`** _(v0.7)_       | MySQL / MariaDB adapter. The `"mysql"` dialect is latent in the renderer today (backtick quoting, `?` placeholders); the adapter ships in [v0.7](v0.7.0-roadmap.md).                                        | core, orm, migrate             |
| **`@sisal/etl`** _(future)_       | Job definitions, rollups, checkpoints, backfill/replay, SQL-pushdown execution.                                                                                                                             | core (+ an adapter to execute) |
| **`@sisal/analytics`** _(future)_ | Typed OLAP query layer: metrics, dimensions, buckets, windows, rankings, period comparison.                                                                                                                 | core (+ an adapter)            |

## The one rule: dependency direction

```
              ┌──────────────┐
              │  @sisal/core │  schema · SQL IR · expressions · dialect
              └──────┬───────┘
     ┌───────────────┼───────────────────────────┐
     │               │                            │
┌────▼────┐    ┌─────▼──────┐   ┌────────┐   ┌─────▼───────┐
│   orm   │    │  migrate   │   │  etl   │   │  analytics  │
│ (OLTP)  │    │            │   │(future)│   │  (future)   │
└────┬────┘    └─────┬──────┘   └───┬────┘   └──────┬──────┘
     └───────┬───────┘              │               │
     ┌───────▼────────┐             │  (etl/analytics may use an
     │   pg · neon    │◄────────────┴──  adapter to execute SQL)
     │ sqlite · libsql│
     │  mysql (v0.7)  │
     └────────────────┘
```

- **ETL and Analytics depend on `@sisal/core`** (and, to execute, on an
  adapter). They may consume ORM _types_.
- **`@sisal/orm` must never depend on ETL or Analytics.** The OLTP core stays
  clean; an app that only does CRUD pulls in none of the analytical surface.
- **Adapters never import each other** and expose their **dialect capabilities**
  explicitly (see [v0.9](v0.9.0-roadmap.md)).

### v0.9 ETL substrate lives in `@sisal/orm` (A3 decision held)

The v0.9 correctness substrate a future `@sisal/etl` runner consumes — the
portable advisory run lock (`Database.tryAdvisoryLock`, T11) and the
checkpoint/watermark helper (`etlCheckpoint`, T12/T13) — ships in
**`@sisal/orm`**, not `@sisal/migrate`. Both need the `Database` facade
(`execute`/`insert`/`batch`) that lives in `@sisal/orm`, and neither reaches
into migrate, so the v0.6 **A3 decision holds: there is no `etl → migrate`
edge.** The `sisal_etl_checkpoints` and `sisal_advisory_locks` system tables are
created and managed by these ORM helpers at runtime
(`CREATE TABLE IF NOT EXISTS` on first use) — not by the migration snapshot/DDL
pipeline, so a job's checkpoint is not part of the user's migrated schema and
never appears as drift the migrator owns. When `@sisal/etl` is built (v0.10) it
consumes these primitives from `@sisal/orm` (adding an `etl → orm` runtime edge
alongside `etl → core`); the substrate does not move. Watermarks are stored as
opaque TEXT, so the checkpoint carries no per-adapter timestamp-type surface to
reconcile.

## Where we are today (the honest baseline)

As of v0.8, **`@sisal/core` exists** as the extracted lower tier. It owns the
schema primitives/snapshots, SQL fragment IR, expression operators, capability
registry, renderer, structured errors, and logger contracts. The fluent
builders, `Database` facade, relations, and typed function caller remain in
`@sisal/orm`, which re-exports the full core surface so existing imports keep
working.

The split follows the layering confirmed by the June 2026 code audit:
`errors ← sql ← {operators, columns} ←
table ← {builders, relations} ← database`.
The lower tier (`errors`, `sql`, `operators`, `columns`, `table`, `temporal`,
and the schema snapshot leaf) has **no upward edges** into the OLTP builders.
The one cross-cut — embedding a query builder as a subquery fragment — remains
inverted behind the `QUERY_BUILDER_BRAND` symbol + a structural `SubquerySource`
interface, exposed only through `@sisal/core/unstable-internal` for the ORM
tier.

**Important nuance for ETL/analytics:** what `@sisal/core` exposes is a
dialect-agnostic **fragment/expression IR plus a serializable schema snapshot**
— a _compile target_, not a transformable relational AST. Downstream packages
can **build and render** parameterized SQL/predicates on it, but query
_introspection/rewriting_ (predicate pushdown, plan optimization) does not exist
today and would be new core work if a milestone genuinely needs it (flagged in
[v0.8](v0.8.0-roadmap.md)).
