# Changelog

This is the canonical changelog for Sisal workspace releases.

The repository starts with an imported baseline commit, `0099bb1`, from the
project Sisal was rebuilt from. That commit is summarized as a baseline instead
of expanded into a full release narrative. The entries below reconstruct the
Sisal-specific history after that baseline through `1f05448`.

## Unreleased

### Added

- Added the `examples/neon-hot-feed` example: a Reddit-style hot feed on
  Neon/PostgreSQL that demonstrates a `/new` (created_at) and `/hot` timeline
  backed by a stored, indexable `hot_score`, keyset (cursor) pagination, and an
  atomic vote mutation through a `app.vote_post` PostgreSQL function — a single
  parameterized statement rather than an interactive `db.transaction` callback,
  for Deno Deploy / Neon HTTP friendliness. Includes hand-written SQL migrations
  (`CREATE FUNCTION` + an `IMMUTABLE` hot-score function), a serverless-safe
  dollar-quote-aware SQL statement splitter, network-free unit tests, and a
  gated database integration test. The README documents the Neon execution-mode
  constraint and the Sisal API pressure points the example surfaced. Registered
  the example in the workspace and the `check` task.
- Added `docs/v0.4.0-roadmap.md`, the working backlog of API gaps surfaced by
  the `neon-hot-feed` example (typed database-function caller, serverless-safe
  SQL migration applier + Neon CLI target, keyset/cursor pagination helper, raw
  expressions in builder `SET`/`VALUES`, richer DDL generation, non-interactive
  batched transactions, and column-name mapping), each with a proposed API,
  affected packages, and acceptance criteria.
- Added the prepared-statement API to `@sisal/orm`: `placeholder(name)` creates
  a deferred parameter slot (Drizzle's `sql.placeholder`) usable in the
  `` sql`...` `` tag and operators, and every builder
  (`select`/`insert`/`update`/`delete` and compound selects) gains
  `prepare(name?)`, returning a `PreparedQuery` run with `execute(values)` /
  `toSql(values)`. The SQL is rendered once and re-bound per call; rendering a
  query that still holds an unbound placeholder is refused. Moves the
  `sql.placeholder` / prepared-statement rows in `docs/drizzle-parity.md` off
  the roadmap.

### Changed

- Updated the pre-commit hook to regenerate and stage `docs/llms.txt` and
  `docs/llms-full.txt`, keeping the generated LLM docs in sync before CI's
  `docs:llms:check` gate.
- Split the `@sisal/orm` core (`packages/orm/core/mod.ts`) into coherent modules
  behind a barrel: `errors`, `sql`, `operators`, `columns`, `table`, `builders`,
  `relations`, and `database`. `mod.ts` now re-exports the same public surface
  (no API change) and the internal value-import graph is an acyclic DAG — `sql`
  detects query builders via a brand symbol instead of importing `builders`.

### Removed

- Removed the Performance/benchmark section (and its nav link and styles) from
  the docs homepage `docs/index.html`. The standalone `benchmarks.html` page and
  its footer link are unchanged.

## 0.3.0 - 2026-06-28

### Added

- Added `columns.customType<T>({ kind, dialectType })` as a trusted column-type
  escape hatch that preserves `dialectType` in schema snapshots and lets
  PostgreSQL DDL emit custom dialect types such as `vector(1536)`, `inet`,
  `time`, `interval`, or identity syntax.
- Added query-builder ergonomics and subqueries: `.distinctOn(...)` (Postgres
  `SELECT DISTINCT ON`),
  `.for("update" | "share", { skipLocked?, noWait?, of? })` row locking,
  `db.$count(table, where?)` returning a `number`, and the
  `countDistinct(column)` aggregate. A select aliased with `.as("x")` becomes a
  derived table for `.from(...)` (columns referenceable as `x.col`); the same
  builder embeds as a parenthesized scalar subquery in projections and `where`,
  and as the operand of `inArray(col, subquery)` / `notInArray`.
- Added the `exists(subquery)` / `notExists(subquery)` predicates and the
  Postgres array operators `arrayContains` (`@>`), `arrayContained` (`<@`), and
  `arrayOverlaps` (`&&`).
- Added generated `llms.txt` and `llms-full.txt` files for GitHub Pages, sourced
  from the API reference, docs, package manifests, and exported API
  documentation.

### Changed

- Bumped workspace package manifests, example/benchmark manifests, and the
  migration CLI's scaffolded adapter imports to `0.3.0`.
- Updated CI, publish, and Pages workflows to verify or regenerate the LLM docs
  files from `deno task docs:llms`.
- Updated README installation guidance to use `deno add` with the published
  `0.3.0` JSR packages and pinned direct CLI examples.
- Expanded the API reference to cover the current public relation-query,
  table-constraint, workflow, CLI, adapter utility, and DDL helper surfaces.
- Serialized SQLite ORM executor work so statements issued on the same executor
  queue behind an open transaction instead of interleaving inside its
  `BEGIN`/`COMMIT` window.
- Pinned CI, publish, Pages, advisory, and integration workflows — and the
  Docker integration runner image (`denoland/deno:2.9.0`, digest-pinned) — to
  Deno `v2.9.0`.

## 0.2.0 - 2026-06-27

### Added

- Added this canonical workspace changelog.
- Added GitHub Actions CI for formatting, linting, type checking, package tests,
  documentation coverage, and JSR publish dry runs.
- Added a publish workflow for workspace packages.
- Added Deno formatting tasks and a pre-commit formatting hook.
- Added brand assets, favicons, README branding, and the generated documentation
  site served by GitHub Pages.
- Added API documentation, Drizzle parity documentation, migration notes,
  database compatibility matrices, and a normalized benchmarks methodology page.
- Added migration benchmark coverage, including a CLI migration scenario.
- Added the `@sisal/migrate/cli` command runner with `generate`, `migrate`,
  `status`, and `drift` workflows backed by `sisal.migrate.ts` configuration.
- Added `@sisal/libsql` for libSQL/Turso ORM execution, migration execution,
  migration history, migrators, and SQLite-compatible DDL aliases.
- Added a libSQL basic example and libSQL integration coverage.
- Added PostgreSQL, SQLite, and libSQL integration feature tests plus Docker
  support for local integration runs.
- Added workspace package discovery tooling so CI and publish workflows can read
  package metadata from the Deno workspace instead of maintaining static package
  lists.
- Added `@sisal/neon` for Neon serverless PostgreSQL, including ORM and
  migration exports that reuse PostgreSQL SQL rendering, DDL, and migrator
  behavior.
- Added Neon documentation, compatibility coverage, integration tests, and a
  basic package README.
- Added benchmark scenarios for SQL generation, Drizzle comparison,
  Drizzle-style proxy execution, and FakeDBProxy execution, plus a Sisal-vs-
  Drizzle execution + result-mapping comparison across dialects.
- Added PostgreSQL and SQLite showcase examples to exercise the broader schema,
  query, migration, and adapter surface.
- Added fluent common table expressions — `db.$with(name).as(query)` (with the
  CTE's columns inferred from the inner query's projection), consumed via
  `db.with(...ctes).select(...).from(cte)` — and chainable set operations
  (`union`, `unionAll`, `intersect`, `intersectAll`, `except`, `exceptAll`)
  returning a `CompoundSelectBuilder` whose trailing `orderBy`/`limit`/`offset`
  bind to the whole compound. Set-operation operands are not parenthesized so
  the same query renders correctly on both Postgres and SQLite. Includes Drizzle
  parity rows and tests, `mod_test` unit coverage, API documentation, CTE
  generation and Drizzle-comparison benchmarks, and showcase example coverage.
- Added PostgreSQL advisory lock support for migration history stores when the
  executor can hold a pinned session.
- Added a scheduled/manual integration workflow for PostgreSQL, Neon, SQLite,
  and libSQL compatibility suites.
- Added release-tag validation so publishing checks package versions and the
  migration CLI's default adapter version against the tag.
- Added project guidance files for repository conventions and agent workflows.
- Added the root MIT license file for the workspace.
- Added core ORM security-invariant tests for parameter binding, identifier
  validation, escape-hatch strictness, where-less mutation guards, and
  credential redaction.
- Added the `sisal/no-raw-interpolation` Deno lint plugin and a
  `deno task audit` OSV advisory/SBOM check.
- Added a scheduled/manual dependency advisory workflow.
- Added the root security policy and security posture documentation page.
- Added table-level schema constraints through a `defineTable` extras callback
  (`defineTable(name, columns, (t) => [...])`): composite
  `primaryKey({ columns })`, named/composite `unique(name).on(...)`, table
  `index` / `uniqueIndex`, and `check(name, expression)`. Unique and check
  constraints emit inline in the generated CREATE TABLE (check columns rendered
  unqualified for cross-dialect portability); indexes emit as separate CREATE
  INDEX statements across PostgreSQL and SQLite/libSQL, with Drizzle parity rows
  and pg/sqlite parity tests.
- Added `onDelete` / `onUpdate` referential actions to the third options
  argument of `.references()`, emitted on the generated foreign keys.

### Changed

- Bumped workspace package manifests to `0.2.0` and switched non-published
  examples/benchmarks to `publish: false`.
- Aligned column nullability semantics so columns are nullable by default,
  `.notNull()` marks required values, and `.optional()` or `.default()` allows
  omitted insert values.
- Expanded ORM query coverage toward Drizzle parity, including richer select,
  insert, update, delete, filtering, ordering, grouping, returning, upsert, and
  relation-query behavior.
- Expanded README coverage from a small package overview into the current
  Deno-first workspace guide with install instructions, package boundaries,
  query examples, migration workflow notes, adapter examples, and benchmark
  commands.
- Replaced the initial docs index with the branded landing page and kept API,
  parity, compatibility, and benchmark docs linked from the docs site.
- Updated CI and publish workflows to use workspace package discovery,
  workspace-level dry runs, and tag-triggered trusted publishing.
- Expanded benchmark dependencies and lockfile entries for Neon, Drizzle, and
  proxy execution scenarios.
- Updated adapter executors and ORM/migration drivers so transaction callbacks
  receive scoped transaction executors instead of implicitly routing all outer
  executor calls through the active transaction.
- Made migration DDL generation compute the schema diff once and derive both the
  emitted statements and the withheld destructive-change list from it (via
  `planSchemaChangesFromDiff`) instead of diffing twice, roughly halving
  additive-diff generation time.
- Generated PostgreSQL, SQLite, and libSQL DDL now emits column-level `UNIQUE`
  and `FOREIGN KEY` constraints, including referential actions.
- Pinned GitHub Actions and Docker integration images to immutable SHAs/digests,
  with Dependabot coverage for updates.
- Documented migration config scaffolds, DDL expression defaults, and
  dialect-specific column types as trusted developer-authored inputs.
- The `sql` template now renders a column reference as a validated, quoted
  identifier instead of a bound parameter, enabling expressions such as
  ``check("age_check", sql`${t.age} >= 0`)``.

### Fixed

- Fixed Neon integration linting by using the intended assertion import.
- Fixed migration application and rollback so transactional drivers can mark or
  unmark migration history through a transaction-scoped store.
- Hardened the PostgreSQL compatibility matrix script so health-check and test
  failures fail the script while still printing the compatibility summary.
- Fixed migration SQL splitting so PostgreSQL dollar-quoted function bodies stay
  intact.
- Redacted DSNs, passwords, and auth tokens from Sisal and Neon error messages
  and preserved causes.

## 0.1.0 - 2026-06-27

### Imported Baseline

- Imported the initial Deno-first workspace shape with `@sisal/orm`,
  `@sisal/migrate`, `@sisal/pg`, and `@sisal/sqlite`.
- Added driverless ORM schema metadata, typed SQL rendering, query builders,
  schema snapshots, structured ORM errors, and logger contracts.
- Added adapter-neutral migration definitions, checksums, planning, drift
  helpers, workflow helpers, and a generic migrator.
- Added PostgreSQL and SQLite adapter boundaries with ORM drivers, migration
  drivers, history stores, migrators, and additive DDL generation.
- Added starter PostgreSQL and SQLite examples, package tests, and the first
  benchmark scaffold.
