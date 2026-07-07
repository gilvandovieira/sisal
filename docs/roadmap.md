---
title: Roadmap Overview
---

# Sisal roadmap — from OLTP correctness to a typed analytics stack

Sisal is a **JSR-first, Deno-native, SQL-first, type-safe** ORM and database
toolkit for **relational** data across PostgreSQL, Neon, SQLite, libSQL, and
MySQL/MariaDB. As of v0.12, the same package set is also published to npm for
Node.js 24+ under the `@sisaljs/*` scope. It will not become an object-first
ORM. This page is the index and narrative spine for the release line; each
release has its own roadmap doc with full
goal/scope/deliverables/non-goals/risks/open-questions/acceptance-criteria.

## The arc

The long-term direction is a layered stack where each tier is a thin, typed
package over shared core primitives — and the OLTP core never depends on the
analytical layers (see [architecture](architecture.md)):

> **ORM** handles OLTP. **ETL** bridges OLTP data into OLAP-ready shapes.
> **Analytics** queries those shapes with a typed OLAP API.

The discipline that keeps this realistic: **investigate before building, and
build the substrate before the feature.** v0.6 and v0.7 are _readiness_
milestones — they earn the right to build ETL and analytics by proving the core
can carry them without hacks. The public packages don't arrive until v0.10+.

## Release line

| Release   | Title                                                                 | Theme                                                                                                                                              | Ships a package?   |
| --------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| **v0.5**  | [Multi-Dialect OLTP Compatibility](v0.5.0-roadmap.md)                 | Make the OLTP builder boringly correct across pg/neon/sqlite/libsql                                                                                | hardening          |
| **v0.6**  | [Foundations & Readiness — ETL + MySQL groundwork](v0.6.0-roadmap.md) | Minimum core changes for `@sisal/etl`; **investigate MySQL support**; an [npm-release readiness report](npm-release-readiness.md) (build deferred) | no                 |
| **v0.7**  | [Analytics Readiness & MySQL Support](v0.7.0-roadmap.md)              | Design the analytical IR; **and** build the `@sisal/mysql` adapter (from v0.6)                                                                     | `@sisal/mysql`     |
| **v0.8**  | [Advanced SQL IR & Expression Stabilization](v0.8.0-roadmap.md)       | Stabilize the IR + extract `@sisal/core` so ETL/analytics can compile in safely                                                                    | `@sisal/core`      |
| **v0.9**  | [Adapter Hardening & Capability Matrix](v0.9.0-roadmap.md)            | Harden all five adapters (pg/neon/sqlite/libsql/**mysql**) per v0.6–v0.7 findings; explicit capability surface                                     | hardening          |
| **v0.10** | [`@sisal/etl` Preview](v0.10.0-roadmap.md)                            | First ETL package: job + runner + checkpoint, SQL-pushdown, Postgres-first; close the 0.9.0 security-audit findings (SEC-008–SEC-016)              | `@sisal/etl`       |
| **v0.11** | [`@sisal/analytics` Preview](v0.11.0-roadmap.md)                      | First analytics package: metrics/dimensions/windows, Postgres-first                                                                                | `@sisal/analytics` |

> **Post-v0.11 is deliberately unplanned.** The DuckDB/external-OLAP,
> native/Rust-acceleration, and `@sisal/dashboard` milestones that once sat here
> were **dropped in July 2026**. Sisal stays a relational OLTP→analytics stack:
> it does **not** pursue native acceleration or a presentation-mapping layer,
> and **DuckDB specifically is off the table**. A future **external database
> target** — for example a **time-series database** — remains a _possible_
> post-v0.11 direction, but **nothing is planned now**; what comes after the
> analytics preview is decided once it ships. npm publishing moved out of the
> feature-release line and shipped as a cross-cutting distribution track in
> v0.12 (see below).

## Release discipline (non-negotiable)

- **v0.6 prepares for ETL; it does not become ETL.** No public `@sisal/etl`.
- **v0.7 prepares for analytics; it does not become analytics.** No public
  `@sisal/analytics`.
- **v0.10 starts ETL. v0.11 starts analytics.** The analytics preview is the
  last planned feature milestone; what follows it is decided after it ships.
- The first ETL model is a **job definition + a single-run runner**, triggered
  by an **external** cron/scheduler — not a worker platform, not
  Airflow/Temporal.
- Heavy work is **pushed down into the database** (aggregate, group,
  insert-from-select, upsert). PostgreSQL is the strongest pushdown target.
- **MySQL is investigated in v0.6, implemented in v0.7.** It joins as a fifth
  dialect/adapter; PostgreSQL remains the ETL/analytics reference.
- **Node.js/npm is a cross-cutting distribution track, not a feature
  milestone.** v0.6 produced the
  [npm-release readiness report](npm-release-readiness.md), then v0.12 shipped
  npm packages under `@sisaljs/*` from the same Deno/JSR source tree and version
  gate.
- **Structural decisions are committed before the IR/adapters freeze, not
  after.** The dialect/capability identity (engine **and version**, e.g. MySQL ≠
  MariaDB ≠ MySQL 5.7), the transformable-AST seam, and the ETL lock/checkpoint
  contract are decided at v0.6–v0.8 so v0.9+ can't cross a gate without its
  prerequisite. See the [sequencing audit](roadmap-sequencing-audit.md).

## What grounds this (June 2026 code audit)

A capability audit of the current builder/IR informs every milestone:

- **OLTP/aggregation is solid** — GROUP BY/HAVING, aggregates, `countDistinct`,
  set operations, `ON CONFLICT` upsert, `RETURNING`, prepared plans, `db.batch`,
  transactions all exist and are tested.
- **ETL's blocking gap is set-based data movement** — `INSERT … SELECT` has no
  builder and CTEs are **SELECT-only**, so "stage → insert/upsert from select"
  isn't buildable today (tracked partly by v0.5 item 12). → drives **v0.6**.
- **Analytics is the weakest area** — **no window functions at all** (no `OVER`,
  ranking, `lag`/`lead`, percentiles, moving averages), and none of it is on the
  v0.5 roadmap. → drives **v0.7**/**v0.11**.
- **The core is "already layered as if pre-split"** — a clean lower tier with no
  upward edges; `@sisal/core` extraction is mostly file-moves. → enables
  **v0.8**.
- **The IR is a compose-oriented _fragment_ IR**, a compile target rather than a
  transformable AST — so ETL/analytics can compile into it; query rewriting
  would be new work. → an explicit **v0.8** open question.
- **MySQL is latent, not absent** — the renderer already carries a `"mysql"`
  dialect (backtick quoting, `?` placeholders, `ilike`→`LIKE`), but there is no
  `@sisal/mysql` adapter, driver, DDL generator, or tests. → scoped in **v0.6**,
  built in **v0.7**.

## Cross-cutting tracks (not on the version line)

Some work is orthogonal to the OLTP→OLAP feature axis and is folded into the
nearest readiness milestone rather than owning a version:

- **Runtime & packaging (Node.js + npm)** — **investigated in
  [v0.6](v0.6.0-roadmap.md), executed after the core split, and shipped in
  v0.12**: npm packages mirror the JSR package set at the same versions under
  `@sisaljs/*`. Deno/JSR remains the primary development and release source; npm
  artifacts are generated from that source tree, with Node 24+ support, ESM-only
  output, optional adapter driver peers, Node examples, and a Node CI leg.
