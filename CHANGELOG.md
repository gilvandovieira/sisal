# Changelog

This is the canonical changelog for Sisal workspace releases.

The repository starts with an imported baseline commit, `0099bb1`, from the
project Sisal was rebuilt from. That commit is summarized as a baseline instead
of expanded into a full release narrative. The entries below reconstruct the
Sisal-specific history after that baseline through `1f05448`.

## Unreleased

### Added

- Added the `examples/postgres-rising-feed` example: the **normal database**
  version of the `/rising` feed on **PostgreSQL 18** via `@sisal/pg` (regular
  TCP session, its own `docker-compose.yml` with `postgres:18`). It completes a
  three-way comparison of the same product feature — normal database
  (`postgres-rising-feed`) vs. constrained runtime (`neon-rising-feed`,
  serverless/single-statement) vs. feature-limited database
  (`libsql-rising-feed`, no stored procedures). It reuses the rising-feed model
  (5-minute buckets, unique-actor dedup, weighted score, stored time-dependent
  `rising_score`, explicit `p_now`, `/new` + `/rising` keyset pagination) with
  the corrected `app.calculate_rising_score` (windows bounded `<= p_now`, so
  future buckets never count) and `#variable_conflict use_column` recorder. Uses
  `mode: "date"` timestamps; since `@sisal/pg` returns `double precision` as a
  string (v0.5.0 roadmap item 11), it `Number(...)`-coerces `rising_score` /
  `activity_score` at the boundary. As a normal-Postgres extra it ships an
  optional interactive-transaction recorder
  (`recordPostActivityWithTransaction`, `db.transaction(...)`) alongside the
  primary `db.call(app.record_post_activity)` path; the gated suite
  (`SISAL_POSTGRES_RISING_FEED_IT=1`) asserts both agree. Network-free unit
  tests + the gated DB suite pass against local `postgres:18`; registered in the
  workspace and the `check` task.
- Added the `examples/neon-rising-feed` and `examples/libsql-rising-feed`
  examples: a Reddit-style **`/rising`** timeline built on **time-bucketed
  activity** and a **moving-window** score, as a matched Neon/PostgreSQL ↔
  libSQL/Turso pair. Both store an indexed, **time-dependent** `rising_score`
  (recomputed at an explicit `now`, never a hidden `now()`), expose `/new` +
  `/rising` with keyset pagination, and prove six product behaviors
  (fresh-burst, decayed-old, comment-storm, steady, report-penalty, unique-actor
  anti-spam) from a deterministic seed pinned to a fixed `DEMO_NOW`. The Neon
  version pushes the activity recorder and scoring into PostgreSQL functions
  called via the typed `db.call`/`defineFunction` surface (one atomic
  statement); the libSQL version reimplements the same logic in TypeScript —
  **SQLite has no stored procedures** — orchestrated through the builder
  (`db.transaction` with `onConflictDoNothing().returning()`, an
  `onConflictDoUpdate` upsert with raw-`sql` increments, and `db.batch` for the
  bulk recompute). Each example has network-free unit tests and a gated DB
  integration suite (`SISAL_NEON_RISING_FEED_IT=1` /
  `SISAL_LIBSQL_RISING_FEED_IT=1`); the libSQL suite and demo were run
  end-to-end against a local SQLite file. Both are registered in the workspace
  and the `check` task. The READMEs document the moving-average model and the
  Sisal API pressure points the pair surfaced (see the v0.5.0 roadmap).
- Hardened the rising-feed examples after running them against real databases:
  fixed `app.calculate_rising_score` (neon-rising-feed) to bound the recent
  windows at `<= p_now` so a bucket dated after `p_now` can never inflate
  `last_15m`/`last_60m` (matches `src/rising.ts`); fixed a latent ambiguity in
  `app.record_post_activity` where the `RETURNS TABLE (...)` output names
  shadowed table columns (`#variable_conflict use_column`); and limited
  `recomputePostRisingScore` (libsql-rising-feed) to the 120-minute window like
  the all-post path. Added future/old-bucket regression tests (network-free and
  gated DB) to both examples and brief "Production notes" to both READMEs. Also
  switched `neon-rising-feed` to Sisal's **default Temporal date types**
  (`columns.timestamp({ withTimezone: true })` → `Temporal.Instant`, opened with
  `temporal: { parse: true }` so reads — feed rows, cursors, `db.call` results —
  are `Temporal.Instant`), with a `Temporal.Instant | Date` fallback in the
  scoring helpers (`toInstant(...)` normalizes the `Date` fallback at the
  `db.call` edge); `libsql-rising-feed` keeps ISO-string `TEXT` since SQLite has
  no native timestamp type. Verified end-to-end against PostgreSQL 18
  (`@sisal/pg`) and the libSQL native client, and the Neon path via the bundled
  `neon-proxy`.
- Recorded new v0.5.0 roadmap pressure points surfaced by the rising-feed
  examples: a portable "transaction script" abstraction for the no-stored-
  procedures gap (so the recorder reads identically across engines),
  `FILTER`-clause aggregates + interval/date math in the builder (the
  moving-window sums currently need raw SQL), a portable `dateTrunc`/time-bucket
  helper, a note that `.optional()` widens the inferred SELECT row type with
  `undefined` (it should affect only the insert type), and a driver-parity gap
  where **`@sisal/pg` returns `double precision` as a string** while
  `@sisal/neon`/`@sisal/sqlite`/`@sisal/libsql` all return a `number` (verified
  against real databases).
- Added richer index DDL generation (roadmap item 5). Table-level `index()` /
  `uniqueIndex()` now accept per-column sort direction via `asc()`/`desc()`
  terms, raw `` sql`...` `` **expression** keys (an expression index), and a
  partial-index predicate via a new `.where(predicate)` builder method — e.g.
  ``index("hot").where(sql`${t.status} = 'published'`).on(desc(t.hotScore), desc(t.id))``
  or ``uniqueIndex().on(sql`lower(${t.email})`)``. The
  `generate{Postgres,Sqlite,Libsql}UpStatements` DDL generators emit the
  `col DESC`/`ASC` ordering, parenthesized expression keys, and the trailing
  `WHERE` clause; expression keys and predicates render portably (table prefix
  stripped, identifiers double-quoted) like CHECK constraints. Adds the public
  `IndexColumnSpec` type and the `SisalIndexColumnSnapshot` schema descriptor.
  **BREAKING (snapshot format):** the serialized index shape changed —
  `SisalIndexSnapshot.columns` is now a list of
  `{ value, direction?, expression? }` objects (was `string[]`) and gains an
  optional `where`, so `SCHEMA_SNAPSHOT_VERSION` is bumped to **2**; regenerate
  `.snapshot.json` files. Covered by the pg/sqlite Drizzle-parity tests and the
  gated pg (16/17/18), SQLite, and libSQL integration suites; moves the parity
  index row.
- Added a non-interactive batched transaction API to `@sisal/orm` (roadmap item
  6). `db.batch([...])` runs several pre-built statements (query builders,
  `` sql`...` `` fragments, or rendered `SqlQuery`) as one atomic,
  non-interactive unit and returns one `OrmQueryResult` per statement — ideal
  for Deno Deploy / Neon HTTP, where an interactive `transaction()` callback
  holds a connection open. Each statement is rendered up front (an unbound
  placeholder throws a clear error before any execution); the whole batch
  commits together and rolls back on failure. A `batch?` hook was added to the
  `OrmDriver` contract and implemented in **every adapter** (`@sisal/pg`,
  `@sisal/neon`, `@sisal/sqlite`, `@sisal/libsql`), each running the batch in
  one atomic transaction. Exports `BatchStatement`. No statement may depend on a
  previous one's result (use `transaction()` or a database function for that).
  Covered by `packages/orm/batch_test.ts` and the gated integration suites.
- Added raw `sql` expressions as builder `SET` / `VALUES` values in `@sisal/orm`
  (roadmap item 4). `.set({...})`, `.values({...})`, and
  `onConflictDoUpdate.set` now accept a `Sql` expression for any column value
  alongside literals — e.g.
  ``.set({ score: sql`${posts.columns.upvotes} - ${posts.columns.downvotes}` })``
  or ``.values({ id, createdAt: sql`now()` })``. Expressions render inline
  (column references render table-qualified) while literal values still bind as
  parameters. Adds the `InsertValues` / `UpdateValues` types (each column value
  widened to `value | Sql`); inference is unchanged. Scope is scalar expressions
  — `UPDATE ... FROM` / `INSERT ... SELECT` remain out of scope. Covered by
  `packages/orm/set_values_expr_test.ts`; moves the parity row.
- Added Temporal-aware date/time support across ORM and adapters for v0.4.0:
  `columns.date()` now defaults to `Temporal.PlainDate`, `columns.time()` was
  added and defaults to `Temporal.PlainTime`, `columns.timestamp()` defaults to
  `Temporal.PlainDateTime`, and `columns.timestamp({ withTimezone: true })`
  defaults to `Temporal.Instant`. Explicit `mode: "date"` and `mode: "string"`
  keep legacy JS `Date` or raw string values. `SqlParameter` /
  `serializeSqlValue()` normalize Temporal values (including arrays and
  `Temporal.ZonedDateTime`) to ISO strings before adapters receive them.
  Database facades accept `temporal: { parse: true }` to opt into
  metadata-driven result decoding for ORM-built selects, `returning()`,
  relational queries, and `db.call(...)`; raw SQL rows are left driver-shaped.
- Added gated pg/neon/sqlite/libSQL integration coverage for Temporal date/time
  modes, including parse-enabled ORM rows, parse-disabled rows, raw SQL
  behavior, string modes, legacy `Date` modes, and `Temporal.ZonedDateTime`
  parameter normalization.
- Added Date-vs-Temporal benchmark scenarios covering raw JS date APIs, Sisal
  parameter serialization/rendering, and database-free ORM result parsing.
- Added a serverless-safe SQL migration applier and a Neon CLI target (roadmap
  item 2). `@sisal/migrate` now exports `splitSqlStatements(sql)` — a
  dollar-quote/`$tag$`/string/quoted-identifier/comment-aware statement splitter
  (hardened to drop empty/stray semicolons) — and the core migrator gained a
  `splitStatements` apply mode that runs each `.sql` `up`/`down` step one
  statement per `driver.execute(...)` call (still recording history), forwarded
  through `createPgMigrator` and `createNeonMigrator`. `createNeonMigrator`
  defaults `splitStatements` to `true` and `useTransaction` to `false` for the
  Neon HTTP transport. The `sisal` CLI adds a **Neon target**:
  `sisal init --neon` scaffolds a `dialect: "postgres"` + `provider: "neon"`
  config (a new `MigrateConfig.provider` discriminator), and `sisal migrate`
  then applies through `@sisal/neon` over HTTP. The `examples/neon-hot-feed`
  example switches to the shared `splitSqlStatements` and drops its local copy.
  Covered by `packages/migrate/{sql_split,split_apply,cli}_test.ts`.
- Added keyset (cursor) pagination to `@sisal/orm` (roadmap item 3):
  `SelectBuilder.keyset({ orderBy, after, form? })` infers the cursor type from
  the `orderBy` columns, emits the keyset comparison against `after` (omit for
  the first page) plus the matching `ORDER BY`, and returns a
  `KeysetSelectBuilder` whose `.limit(n).execute()` yields
  `{ rows, nextCursor }` (a `nextCursor` only when a full page came back). Two
  predicate forms: the default `"expanded"` nested `or`/`and` (mixed directions,
  every dialect) and `"row-value"` (`(a, b, c) < (x, y, z)`, a single
  direction). To support it, `asc()`/`desc()` now return an `OrderTerm` — a
  `Sql` subtype that also carries the column and direction, fully backward
  compatible — and a column's `propertyName` is a literal type so cursor keys
  infer. Exports `OrderTerm`, `isOrderTerm`, `KeysetOptions`, `KeysetCursor`,
  `KeysetKeys`, `KeysetPage`, and `KeysetSelectBuilder`. The
  `examples/neon-hot-feed` feeds (`getNewFeed`, `getHotFeed`) are now
  builder-native via `.keyset(...)`, dropping the raw-SQL `/hot` keyset. Adds a
  divergence-by-design row to `docs/drizzle-parity.md` (Drizzle has no
  first-class keyset helper).
- Added a typed database-function caller to `@sisal/orm` (roadmap item 1):
  `defineFunction(name, { args, returns })` declares a function's positional
  argument column types and its return shape — a `RETURNS TABLE (...)` column
  map (typed row) or a single column builder (typed scalar). `db.call(fn, args)`
  renders one `select * from <schema.fn>($1::t1, …)` statement with the `::type`
  casts taken from the argument column types and every value bound, then runs it
  with `.execute()` (all rows) or `.one()` (asserts exactly one row); a scalar
  return renders `select fn(...) as "result"` and unwraps the value. Pure
  `@sisal/orm` with no adapter changes. Exports `defineFunction`,
  `FunctionDefinition`, `FunctionCall`, `FunctionConfig`, `FunctionArgsConfig`,
  `FunctionReturnsConfig`, `FunctionArgsInput`, and `FunctionRow`. The
  `examples/neon-hot-feed` `src/vote.ts` is rewritten to use it (no raw `sql`
  string), and the README's function-caller pressure point is resolved.
- Added column-name mapping to `@sisal/orm` (roadmap item 7): `defineTable`
  derives physical column names through a naming strategy, the `naming` option
  (`"snake_case"` | `"camelCase"` | `"preserve"` | a `(key) => name` function),
  and a process-wide `setDefaultColumnNaming(strategy)` /
  `getDefaultColumnNaming()` pair. `.named(...)` (already present) declares an
  explicit physical name and always wins. The builder maps the JS property key
  to the physical column on both write (INSERT column list, UPDATE/`SET`,
  `ON CONFLICT` target/set) and read (`SELECT *` and `RETURNING *` expand to
  `"t"."phys" as "key"` once a table has any renamed column), so application
  code that stays inside the builder is transparent to the strategy. Exports
  `ColumnNamingStrategy`, `DefineTableOptions`, `setDefaultColumnNaming`,
  `getDefaultColumnNaming`. Moves the `casing` / explicit-name rows in
  `docs/drizzle-parity.md` off the roadmap and flips item 7 to done.
  - **BREAKING:** the default strategy is `snake_case`, so a plain `defineTable`
    now maps camelCase property keys to snake_case columns (e.g. `hotScore` →
    `hot_score`). Keys that are already snake_case or single words are
    unchanged. Pass `naming: "preserve"` (per table) or
    `setDefaultColumnNaming("preserve")` (global) to restore the pre-0.4.0
    verbatim behavior.
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

- Reworked the root README to match the current core/adapters positioning,
  clarify experimental status and install stacks, document CLI task setup,
  consolidate examples around one PostgreSQL walkthrough, update the current API
  summary, remove comparison-forward Drizzle wording, and add an AI-generated
  README disclaimer.
- Reworded the docs homepage to clarify Sisal's core/adapters split, JSR/runtime
  dependency boundaries, Drizzle inspiration, autogenerated docs note, and
  package presentation.
- **BREAKING:** PostgreSQL DDL now emits `timestamp` for `columns.timestamp()`
  and `timestamptz` only for `columns.timestamp({ withTimezone: true })`.
  Existing users who relied on the old instant/timestamptz behavior should opt
  into `withTimezone: true`; users who want legacy JS `Date` values should also
  set `mode: "date"`, e.g.
  `columns.timestamp({ withTimezone: true, mode: "date" })`.
- Extended the PostgreSQL (`integration/pg_features_test.ts`) and SQLite
  (`integration/sqlite_features_test.ts`) feature suites to cover the new v0.4.0
  surfaces — column naming (snake_case default / `.named()` / `preserve`),
  keyset pagination (both predicate forms), and prepared statements on both
  engines, plus the typed function caller (`defineFunction` / `db.call`) on
  Postgres. Refreshed `docs/pg-compatibility.md` and
  `docs/sqlite-compatibility.md` (now **27 / 27** on pg16/17/18 and SQLite 3.46)
  and the homepage `#compat` badges/feature list.
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
