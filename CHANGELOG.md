# Changelog

This is the canonical changelog for Sisal workspace releases.

The repository starts with an imported baseline commit, `0099bb1`, from the
project Sisal was rebuilt from. That commit is summarized as a baseline instead
of expanded into a full release narrative. The entries below reconstruct the
Sisal-specific history after that baseline through `1f05448`.

## 0.2.0 - 2026-06-27

### Added

- Added this canonical workspace changelog.
- Added GitHub Actions CI for formatting, linting, type checking, package tests,
  documentation coverage, and JSR publish dry runs.
- Added a publish workflow for workspace packages.
- Added Deno formatting tasks and a pre-commit formatting hook.
- Added brand assets, favicons, README branding, and the generated documentation
  site served by GitHub Pages.
- Added API documentation, Drizzle parity documentation, migration notes, and
  database compatibility matrices.
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
  Drizzle-style proxy execution, and FakeDBProxy execution.
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

### Fixed

- Fixed Neon integration linting by using the intended assertion import.
- Fixed migration application and rollback so transactional drivers can mark or
  unmark migration history through a transaction-scoped store.
- Hardened the PostgreSQL compatibility matrix script so health-check and test
  failures fail the script while still printing the compatibility summary.

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
