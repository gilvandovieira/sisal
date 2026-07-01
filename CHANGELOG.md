# Changelog

This is the canonical changelog for Sisal workspace releases.

The repository starts with an imported baseline commit, `0099bb1`, from the
project Sisal was rebuilt from. That commit is summarized as a baseline instead
of expanded into a full release narrative. The entries below reconstruct the
Sisal-specific history after that baseline through `1f05448`.

## Unreleased

### Added

- **Documentation-only advanced SQL example contracts** under
  [`examples/advanced-sql-contracts/`](examples/advanced-sql-contracts/README.md).
  Twelve Markdown **future compatibility contracts** — ETL rollup, window
  analytics, sessionization, top-N per group, cohort retention, funnel analysis,
  recursive comments, job-queue locking, idempotent backfill, JSON→table
  extraction, generated columns/indexes, and MySQL compatibility — that preserve
  product-shaped advanced-SQL example ideas and map each to the roadmap release
  that must build the missing primitive first (v0.6 ETL/locking/MySQL readiness
  → v0.7 analytics/MySQL → v0.8 IR → v0.10 `@sisal/etl` → v0.11
  `@sisal/analytics`). Each contract carries a status, roadmap owner, related
  runnable examples, the SQL shape to preserve, required future primitives, a
  per-dialect classification (PostgreSQL · Neon · SQLite · libSQL · future
  MySQL), a portable/emulatable/dialect-native/fail-guarded split that routes
  genuine per-dialect limits to a future `❌` row in
  [`docs/feature-matrix.md`](docs/feature-matrix.md), non-goals, and future
  acceptance criteria. **Nothing here is runnable or part of the workspace**: no
  `deno.json`, no `mod.ts`, no entry in the root workspace or `deno task check`.
- **`examples/README.md`** — a new index separating the **runnable** workspace
  examples from the **documentation-only** future contracts, making explicit
  that `examples/advanced-sql-contracts/` is not runnable and not in the
  workspace.
- **Roadmap sequencing audit**
  ([`docs/roadmap-sequencing-audit.md`](docs/roadmap-sequencing-audit.md)) — a
  gate-level audit of the v0.6→v0.14 plan: re-derives the cross-cutting gates
  and finds where a gate can be crossed without its real prerequisite (the
  dialect identity has no version/variant axis; the ETL-runner lock/checkpoint
  substrate is design-only; the transformable-AST mitigation isn't
  acceptance-gated), with fixes tied to the v0.9 capability descriptor. Includes
  an appendix validating the dialect-axis finding against live MySQL 8 / MySQL
  5.7 / MariaDB.
- **npm-release readiness report**
  ([`docs/npm-release-readiness.md`](docs/npm-release-readiness.md)) — the
  standing spec for what must change to publish Sisal on npm (manifests + the
  six `jsr:`/`npm:` import sites, the `.ts`→`.js` build, dual-runtime tests,
  CI), plus the npm-name blocker (`@sisal` is taken on npm). Replaces v0.6's
  Node/npm build workstream.

### Changed

- **Roadmap (v0.6 → v0.13):** demoted Node.js/npm from a v0.6 build workstream
  to the deferred [npm-release readiness report](docs/npm-release-readiness.md)
  (build + dual publish moved to v0.13+, on demand, gated on a chosen npm name);
  v0.6 is now two investigation workstreams + that report. Threaded the
  sequencing-audit fixes through the line: an `(engine, version)` dialect-key
  decision in v0.6, a variant/version-tagged `@sisal/mysql` in v0.7, an
  `(engine, version)` capability descriptor + a shipped transformable-AST
  extension point in v0.8, the ETL lock/checkpoint substrate promoted into v0.9
  acceptance, and checkpoint-ownership + tested-lock requirements in v0.10.
- **Docs (examples):** corrected two stale example READMEs.
  `neon-activity-vectors` now calls its `libsql-activity-vectors` counterpart a
  **planned/future** sibling (it does not exist yet) and links the relevant
  advanced-SQL contracts. `neon-hot-feed`'s pressure points now note that
  `UPDATE … FROM` / `INSERT … SELECT` **landed in v0.5** (mutation joins +
  `insert().select()`, as the `neon-rising-feed-ctes` sibling demonstrates), and
  explain the narrower, honest reason its bulk recompute stays raw (a joined
  `FROM … LEFT JOIN (subquery)` source kept as a deliberate escape-hatch demo)
  rather than the old "no builder surface" claim.
- **Docs (roadmap):** [v0.6.0](docs/v0.6.0-roadmap.md) (A5/A6) and
  [v0.7.0](docs/v0.7.0-roadmap.md) (required examples) now link
  `examples/advanced-sql-contracts/` as the preserved backlog of future,
  product-shaped examples.

## 0.5.0 - 2026-06-30

### Added

- **Example consolidation: the `neon-rising-feed-ctes` recompute is now
  builder-native** (v0.5.0 roadmap items 9 + 12 + 13, examples). The example's
  per-post and bulk rising-score recompute (`src/rising.ts`) moved off a raw
  `sql` string onto the builder —
  `db.with(scoreWindows, computedScore).update(posts).from(computedScore)
  .returning(...)`
  — with the moving-window aggregates as `filter(sum(...), …)` over
  `dateSub(now, …)` bounds. It still renders one `UPDATE … FROM` over chained
  CTEs, so the example keeps teaching the CTE shape; only the authoring changed.
  The raw activity recorder (`src/activity.ts`) stays a raw CTE — its
  `onConflictDoUpdate` recompute bridged by an `exists(...)` actor-flag is the
  one shape the builder can't yet author — but now decodes its result with
  `db.query(...).as(postActivityBuckets)`, and both `RecordedBucket`
  (`InferSelect<typeof postActivityBuckets>`) and `RecomputedPost`
  (`Pick<Post, …>`) derive from the table models instead of being hand-restated.
  Verified end-to-end against **real Neon** to produce results identical to the
  previous raw CTE and the TypeScript model. This closes the example follow-ups
  for items 9, 12, and 13; the sibling `neon-rising-feed` (stored function) and
  `libsql-rising-feed` (interactive TypeScript) keep their idiomatic per-engine
  forms by design.
- Added **mutation joins and the mutating `WITH` terminal** (v0.5.0 roadmap item
  12 core). `db.with(...)` can now terminate in `update`/`insert`/`delete`, not
  only `select`, prepending the CTEs to the mutation. A mutation can read
  another relation: `update(t).from(source)` renders `UPDATE … FROM` and
  `insert(t).select(query)` renders `INSERT … SELECT` (both supported on every
  adapter, incl. modern SQLite/libSQL); `delete(t).using(source)` renders
  `DELETE … USING` (PostgreSQL-only — a typed `OrmError` guard throws on the
  SQLite family). Together these let one CTE's mutation read another's
  `RETURNING`
  (`with moved as (delete … returning) insert into archive select …
  from moved`).
  The three mutation builders were first refactored to the same `#state` +
  `#with(patch)` shape `SisalSelectBuilder` uses (behavior-preserving; no public
  change). New methods: `WithQueryBuilder.insert/update/delete`,
  `UpdateBuilder.from`, `DeleteBuilder.using`, `InsertBuilder.select`. Covered
  by `packages/orm/mutation_cte_test.ts` (render + guard + mutual-exclusion) and
  a `mutation joins` integration test on PostgreSQL 18, Neon, SQLite, and libSQL
  (now 39/39/38/38); a unified-matrix row added (✅ on every adapter). Item 12's
  builder gaps are closed and the `neon-rising-feed-ctes` recompute now uses
  them (see the example-consolidation entry above), so item 12 is complete.

- Added **SQL-expression column defaults** (v0.5.0 roadmap item 7 follow-up,
  core). `column.default(...)` now accepts a `sql` fragment in addition to a
  literal or a client-side `() => value`. A `sql` fragment is a **server**
  default emitted into DDL verbatim — a `uuid` primary key defaulted to
  `gen_random_uuid()`, or a timestamp defaulted to `now()`, generate
  `DEFAULT gen_random_uuid()` / `DEFAULT now()`. Unlike a client default, the
  column is simply omitted on insert when no value is given, so the database
  fills it; it stays insert-optional. The snapshot already modeled this
  (`SisalColumnDefault` with `kind: "expression"`) and the PostgreSQL/SQLite
  generators already emit it — only the builder entry point was missing, so a
  `defineTable` schema can now express the `gen_random_uuid()` / `now()`
  defaults a hand-written `CREATE TABLE` uses. A parameterized default throws,
  since a default must be emitted verbatim. Stored as
  `ColumnDefinition.sqlDefault` (separate from `defaultValue`, so projection
  type inference is unaffected). Covered by `packages/orm/mod_test.ts`.

- Added **typed raw-query result mapping** (v0.5.0 roadmap item 13, core). A raw
  `db.query(...)` now returns a `MappableQueryResult` — still an awaitable
  `OrmQueryResult` promise, but it also exposes `.as(...)`, which decodes the
  raw driver rows: physical→JS column naming (`hot_score` → `hotScore`) plus the
  same opt-in Temporal decoding the query builder applies. Pass a `defineTable`
  model for typed `InferSelect<table>` rows, or a free-form `ColumnMap`
  (`{ key: { name?, dataType?, valueMode?, array? } }`) for a result that
  doesn't match one table — a join, an aggregate, a CTE projection. A
  hand-written `sql` query (e.g. a data-modifying CTE) can reuse existing column
  metadata instead of a restated row type. Unknown columns pass through
  untouched, and a plain `await db.query(...)` is unchanged (raw, driver-shaped
  rows). New `@sisal/orm` exports: `MappableQueryResult`, `ColumnMap`,
  `ColumnMapping`; the four adapter facades
  (`PgDatabase`/`NeonDatabase`/`SqliteDatabase`/`LibsqlDatabase`) widen their
  `query` return type to match. Covered by `packages/orm/raw_mapping_test.ts`
  (table + map, naming + Temporal decode + pass-through + rejection) and a
  `typed raw-query mapping` integration test in all four suites (now
  38/38/37/37) executing both `.as(table)` and `.as(map)` on PostgreSQL 18,
  Neon, SQLite, and libSQL; a unified-matrix row added (✅ on every adapter).
  Both input forms are in, and the `neon-rising-feed-ctes` example now uses them
  — its recorder decodes via `db.query(...).as(postActivityBuckets)` and both
  `RecordedBucket` and `RecomputedPost` derive from the table models (see the
  example-consolidation entry above) — completing item 13.
- Added **conditional aggregates and portable date math** (v0.5.0 roadmap item
  9, core). `filter(aggregate, condition)` appends a `FILTER (WHERE …)` clause
  to any aggregate — `filter(sum(score), eq(kind, "a"))` renders
  `sum("score") filter (where "kind" = $1)` — supported natively by PostgreSQL
  and modern SQLite/libSQL, so it renders identically on every adapter. A
  portable date-math set makes a moving-window query builder-native on every
  engine: `dateTrunc(field, source)` truncates to a calendar field; `now()` is
  the current timestamp; `dateAdd`/`dateSub(source, duration)` do interval
  arithmetic (`gte(col, dateSub(now(), { minutes: 15 }))`); and
  `dateBin(every, source)` floors to an arbitrary-width bucket (the 5-minute
  floor `dateTrunc`'s calendar fields can't express). Each renders its own
  per-dialect SQL — `date_trunc` / `now()` / `… ± interval` /
  `to_timestamp(floor(epoch/N)*N)` on PostgreSQL, and `strftime` /
  `datetime('now')` / chained `datetime(…)` modifiers /
  `datetime((unixepoch/N)*N)` on the SQLite family — built on a new public
  `dialectSql(construct, variants, fallback?)` primitive (a per-dialect SQL
  fragment that throws a typed `OrmError`, `code: "ORM_DIALECT_UNSUPPORTED"`,
  when no variant or fallback matches). Date results come back as a `timestamp`
  on PostgreSQL and ISO-8601 `TEXT` on the SQLite family, both ordering and
  grouping identically. New `@sisal/orm` exports: `filter`, `dateTrunc`,
  `DateTruncField`, `now`, `dateAdd`, `dateSub`, `dateBin`, `DateDuration`,
  `dialectSql`. Covered by `packages/orm/aggregates_test.ts` (per-dialect
  render + validation) and `filter aggregate + dateTrunc` and `date math window`
  integration tests in all four suites (now 38/38/37/37) — the latter runs the
  actual rising-score moving window (filter + dateSub + now) and `dateBin`
  bucketing on PostgreSQL 18, Neon, SQLite, and libSQL. Three unified-matrix
  rows added. The `neon-rising-feed-ctes` example gains a builder-native
  `selectRisingScore` (in `src/queries.ts`) that computes the moving-window
  score with `filter` + `dateSub` — verified against real Neon to equal the
  raw-SQL recompute CTE and the TypeScript model — so its item-9 "no
  `FILTER`/interval math" pressure point is resolved. The
  `neon-rising-feed-ctes` recompute _write_ also now uses these helpers (see the
  example-consolidation entry above), so that example's window math left raw SQL
  entirely; `libsql-rising-feed` (no-stored-proc TS) and `neon-rising-feed`
  (stored function) keep their idiomatic per-engine forms by design. Item 9 is
  complete.
- Added **stored schema objects** to the snapshot (v0.5.0 roadmap item 7, core).
  A `createSchemaSnapshot({ tables, schemaObjects })` may now carry raw,
  dialect-gated DDL fragments — functions, triggers, views, extensions, or any
  verbatim `CREATE …` — emitted **after** all table/column/constraint/index
  creation, in declared order, so a `defineTable` schema can hold the stored
  logic an app would otherwise keep in a hand-written `.sql` migration. New
  public surface on `@sisal/orm`: the `SisalSchemaObjectSnapshot` type,
  `defineSchemaObject`, `selectSchemaObjects` (dialect + change filter, used by
  the adapter DDL generators), and `schemaObjectDropStatements` (reverse-order
  `down` drops). Each object has an optional `dialect`: omit it to emit
  everywhere, or set it to gate to one engine — a Postgres-only function is
  skipped by the SQLite-family generator, never emitted as SQL the engine
  rejects. The three additive DDL generators
  (`generate{Postgres,Sqlite,Libsql}UpStatements`) append the selected objects
  after their index loop; libSQL shares the SQLite path. Covered by
  `packages/orm/schema_test.ts` (select/gating/drop-order/normalization) and
  pg/sqlite render tests, plus a `schema objects` integration test in all four
  suites (now 35 each) executing a real trigger + view on PostgreSQL 18, Neon,
  SQLite, and libSQL and asserting cross-dialect gating; a unified-matrix row
  added (pg/neon/sqlite/libsql ✅). The down side is
  `schemaObjectDropStatements` (reverse-order drops, a pg integration test
  applies up then down and asserts the objects are gone); drift over a changed
  function/trigger **body** is caught by `equalSchemaSnapshots`/`checkDrift`
  (schemaObjects are part of the normalized snapshot). With the new
  SQL-expression server defaults (above), `examples/neon-hot-feed` now
  **generates** its full init DDL — tables, DESC indexes, the CHECK, and both
  functions — from `src/schema.ts`, with no hand-written `.sql` files (verified
  against real Neon). This completes item 7.
- Added **data-modifying CTEs** (v0.5.0 roadmap item 12, core). A CTE body may
  now be an `INSERT`/`UPDATE`/`DELETE … RETURNING` builder, not just a `SELECT`
  — `db.$with("x").as(db.insert(t).values(...).returning())` — and the
  `db.with(...)` chain terminates in a `SELECT` that reads the `RETURNING`
  columns, so a mutation and its result are one statement. **PostgreSQL-only:**
  the SQLite family's CTEs are `SELECT`-only, so rendering a data-modifying CTE
  for a SQLite-family dialect throws a typed `OrmError` (via the item-4 dialect
  guard). New public `CteOperand` type; `.as()` accepts the mutation builders.
  Render tests pin the SQL + both guards; executed on PostgreSQL 18 and Neon,
  and a unified-matrix row added (pg/neon ✅, sqlite/libsql ❌). This was the
  first slice; chained data-modifying CTEs, the mutating terminal
  (`with(...).update(...).returning()`), and the `neon-rising-feed-ctes` example
  refactor all landed subsequently (see the mutation-joins and
  example-consolidation entries above), completing item 12.
- Added `defineAtomicOperation` — a portable atomic **transaction script**
  (v0.5.0 roadmap item 8). Author dependent read-modify-write steps once;
  `op.run(db, input)` executes them on every adapter
  (`@sisal/pg`/`@sisal/neon`/`@sisal/sqlite`/`@sisal/libsql`), replacing
  per-engine hand-written transaction/function code with one definition shaped
  by the domain, not the engine. Called with a plain body it runs as a single
  interactive transaction everywhere (committing together, rolling back on
  error). Called with the config form `{ body, singleStatement }` it
  **dispatches on dialect**: the PostgreSQL family runs `singleStatement` as one
  statement — no `BEGIN`/`COMMIT` round trips, intended for a data-modifying
  `WITH` (item 12) such as `with u as (update … returning n) select n from u` —
  so it is one round trip on Neon HTTP, while the SQLite family runs the
  interactive `body` in a transaction. Both forms return the identical
  read-modify-write result from one call site. Covered by
  `packages/orm/atomic_test.ts` (network-free wrapping + dialect dispatch) and
  `atomic operation` + `atomic op single-round-trip
  dispatch` integration
  tests in all four suites (now 40/40 on PostgreSQL 18 and Neon) plus a
  unified-matrix row. The single-statement path is exercised end-to-end on real
  Neon by the `neon-rising-feed-ctes` recompute (see the example-consolidation
  entry above). Full recorder unification across the sibling examples was
  deliberately not pursued — they keep their idiomatic per-engine forms — and an
  optional generated-`CREATE FUNCTION` backing (item 7) remains a future option,
  so item 8 is complete.
- Added typed render-time dialect guards for the PostgreSQL-only query builders
  (v0.5.0 roadmap item 4): rendering `distinctOn`, `.for("update"/"share")` row
  locking, or the array operators (`@>`/`<@`/`&&`) for a SQLite-family dialect
  now throws a typed `OrmError` (`code: "ORM_DIALECT_UNSUPPORTED"`) naming the
  construct and the dialect, instead of emitting SQL the engine rejects as a raw
  syntax error. Implemented as a zero-width `dialectGuard` SQL marker checked in
  the renderer, so Postgres/Neon rendering and execution are byte-for-byte
  unchanged (verified: the pg suite stays 31/31, including all three
  constructs). Covered by `packages/orm/dialect_guard_test.ts`.
- Added the unified **cross-driver feature matrix** (v0.5.0 roadmap item 3): a
  single `docs/feature-matrix.md` — one row per feature, one column per adapter
  across `@sisal/pg`/`@sisal/neon`/`@sisal/sqlite`/`@sisal/libsql` — generated
  from a machine-readable source of truth (`tools/feature_matrix.ts`) by
  `tools/generate_feature_matrix.ts`. New tasks `deno task docs:matrix`
  (regenerate) and `docs:matrix:check` (verify current). The generator also
  asserts every `✅`/`⚠️` cell is backed by a named integration test in the
  matching suite — a coverage guard that fails if the matrix claims coverage no
  test backs (the mechanism behind roadmap item 6). Wired into the pre-commit
  hook (regenerated + staged alongside the LLM docs) and surfaced from the
  homepage `#compat`. 25 features × 4 adapters, 92 ✅/⚠️ cells all test-backed.
- Added a committed `.env.example` documenting every integration-test env var
  (the `DATABASE_URL` / `NEON_*` / `TURSO_*` connection vars and the
  `SISAL_*_IT` suite gates), grouped per adapter with the local-vs-real and
  empty-vs-unset caveats. Run the gated suites with
  `deno test --env-file=.env …` (Deno does not auto-load `.env`). Added `.env`,
  `.env.local`, and `.env.*.local` to `.gitignore` so local/secret values are
  never committed.
- Added `docs/editor-lsp.md` and a minimal `.vscode/settings.json` to document
  verified `deno lsp` editor setup for the Deno/JSR workspace. The probe
  confirms Deno's language server resolves `@sisal/*` package exports and
  preserves types, while a plain TypeScript language server still reports the
  workspace imports as unresolved; the doc records that boundary as a future npm
  packaging signal.
- Added a **forward roadmap line** (`docs/v0.6.0-roadmap.md` …
  `docs/v0.14.0-roadmap.md`) plus a `docs/roadmap.md` overview/index and a
  `docs/architecture.md` describing the long-term package split. These are
  guidelines for future cycles, not commitments; nothing here is implemented
  yet, and v0.5.0 scope is untouched. The arc: **ORM (OLTP) → ETL (bridge to
  OLAP shapes) → Analytics (typed OLAP) → Dashboard (renderer-agnostic
  presentation models)**, with a strict dependency rule —
  ETL/Analytics/Dashboard depend on `@sisal/core`; `@sisal/orm` never depends on
  them. Grounded in a June 2026 code audit (the OLTP/aggregation surface is
  solid; the ETL gap is set-based movement — no `INSERT…SELECT`, SELECT-only
  CTEs; analytics has no window functions at all; the core is "already layered
  as if pre-split" so a `@sisal/core` extraction is mostly file-moves; the SQL
  IR is a compose-oriented _fragment_ IR, a compile target rather than a
  transformable AST).
  - **v0.6 — Foundations & Readiness:** three readiness workstreams that ship no
    new feature package — (A) ETL readiness investigation; (B) the Node.js and
    npm dual-registry runtime work (the original v0.6 content, now Workstream B
    — keeps `@sisal/*` on JSR, publishes a placeholder `@scope/*` on npm since
    `@sisal` is taken there, with the build remapping for the npm artifact
    only); and (C) MySQL support investigation (the renderer already carries a
    latent `"mysql"` dialect, but there is no adapter).
  - **v0.7** Analytics Readiness **+ MySQL Support Implementation** (ships
    `@sisal/mysql`, the fifth dialect); **v0.8** Advanced SQL IR & expression
    stabilization (extracts `@sisal/core`); **v0.9** adapter hardening across
    the five adapters; **v0.10** `@sisal/etl` preview; **v0.11**
    `@sisal/analytics` preview; **v0.12** `@sisal/dashboard` preview; **v0.13+**
    DuckDB / external OLAP investigation (after the analytics IR); **v0.14+**
    optional native/Rust acceleration (only on benchmark evidence).
- Added the `examples/neon-rising-feed-ctes` example: the same `/rising`
  moving-window feed on Neon/PostgreSQL (`@sisal/neon`) but with **no database
  functions** — every multi-step mutation is one **data-modifying CTE**
  statement. `recordPostActivity` is a single
  `WITH … INSERT … ON CONFLICT … RETURNING` (validate kind, inline 5-minute
  bucket, dedupe actor, upsert counters, recompute `activity_score`);
  `recomputePostRisingScore` / `recomputeAllRisingScores` are single
  `WITH … UPDATE … FROM … RETURNING` statements with `FILTER`ed moving-window
  aggregates (windows bounded `<= now` so future buckets never count). The feeds
  stay builder-native (`.keyset(...)` handles the three-column `/rising`
  predicate — not a raw-SQL gap). Network-free unit tests + a gated DB suite
  (`SISAL_NEON_RISING_CTE_FEED_IT=1`) cover dedup, weights, report penalty,
  recompute = TS model, bulk recompute, ordering, keyset pagination, window
  decay, future-bucket exclusion, determinism, and invalid-kind rejection; all
  three gated tests were run end-to-end against PostgreSQL 18 via the bundled
  `neon-proxy`. Registered in the workspace and the `check` task. Surfaced
  v0.5.0 roadmap items 12 (data-modifying CTE builder) and 13 (typed raw-query
  result mapping); see the example README "Sisal API pressure points".
- Recorded v0.5.0 roadmap items **12** (a data-modifying CTE builder —
  `WITH … INSERT/UPDATE/DELETE … RETURNING`; Sisal's `$with`/`with` are
  SELECT-only) and **13** (typed raw-query result mapping for `db.query`),
  surfaced by `neon-rising-feed-ctes`.
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

### Changed

- Fixed `.optional()` to not widen the inferred **SELECT** row type (v0.5.0
  roadmap item 10). `.optional()` is an insert-only axis, but it was adding
  `undefined` to the column's value type, so a nullable `.optional()` column
  inferred `T | null | undefined` on select instead of `T | null` — breaking
  assignment to a hand-written `T | null` row interface. It now affects only
  `InferInsert` (the key stays omittable, accepting `T | null` when present);
  `InferSelect` is `T | null`. This is a type-only change (no runtime behavior
  change). Pinned by a type test in
  `packages/orm/drizzle_parity/columns_test.ts`.
- Fixed `@sisal/pg` to decode `float4`/`float8` (`columns.real()` /
  `columns.doublePrecision()`) as `number` (v0.5.0 roadmap item 11). The bundled
  `jsr:@db/postgres` driver decodes those OIDs (700/701) to **strings**, so a
  `doublePrecision` column — typed `number` — read back a `string` on
  `@sisal/pg` alone (`@sisal/neon`/`@sisal/sqlite`/`@sisal/libsql` already
  return numbers), silently breaking `.toFixed()` and lexicographic-vs-numeric
  ordering. The ORM executor now coerces float-typed result columns by OID;
  `numeric`/`bigint` (1700/20) deliberately stay precision-preserving strings.
  Verified against PostgreSQL 18, and a
  `float (real/double) reads back as number` test is added to all four
  integration suites (now 32 each) plus a tested
  `Float (float4/float8) round-trip` row in the unified matrix.
- Closed the libSQL integration coverage gap (v0.5.0 roadmap item 1): ported the
  three SQLite parity tests the libSQL suite was missing — **column naming**
  (snake_case default / `.named()` / `preserve`), **keyset pagination** (both
  predicate forms), and **prepared statements** — into
  `integration/libsql_features_test.ts`. libSQL renders identical SQLite SQL
  (`LIBSQL_DIALECT = "sqlite"`), so the assertions are dialect-identical; only
  `connect`/teardown differ. Refreshed `docs/libsql-compatibility.md` (matrix
  gains the three rows, now **31 / 31**) and the homepage `#compat` libSQL badge
  (`28/28 → 31/31`). All 31 verified green on a local libSQL file.
- Closed the Neon integration coverage gap (v0.5.0 roadmap item 2): added the
  seven `@sisal/pg` parity tests the Neon suite was missing — **column naming**,
  **keyset pagination** (both forms), the **typed function caller**
  (`defineFunction` / `db.call`, incl. `RETURNS TABLE` + arg casts), **prepared
  statements**, **`sql` in `SET`/`VALUES`/`onConflict`**, **`db.batch`** (atomic
  commit + rollback), and **rich indexes** (DESC / partial / expression) — to
  `integration/neon_features_test.ts`. Neon is PostgreSQL through
  `createPgOrmDriver` + `POSTGRES_DIALECT`, so these mirror the `pg:` tests
  verbatim apart from connect/teardown. Refreshed `docs/neon-compatibility.md`
  (matrix reaches feature parity with the pg matrix, now **31 / 31**) and the
  homepage `#compat` Neon badge (`17/17 → 31/31`). All 31 verified green through
  the Docker `neon-proxy` against PostgreSQL 17, and once end-to-end against a
  live Neon endpoint. This also makes the `db.batch` entry's "the gated
  integration suites" coverage claim true on every adapter
  (pg/neon/sqlite/libsql).
- Trimmed the four per-engine compatibility docs
  (`docs/{pg,neon,sqlite,libsql}-compatibility.md`) to engine-specific metadata,
  behavior notes, and reproduce steps, retiring their now-redundant per-engine
  feature tables in favor of a link to the unified cross-driver feature matrix
  (`docs/feature-matrix.md`). Completes v0.5.0 roadmap item 3 (one matrix, one
  source of truth).
- Made `docs/feature-matrix.md` the single canonical reference for the
  principled cross-driver divergences (v0.5.0 roadmap item 5): every ⚠️/❌ cell
  now links to a one-paragraph reason in a generated **Round-trip differences**
  section (plus a value-shape summary table covering `numeric`/`bigint`,
  `json`/array, `boolean`, `bytea`, and `double precision`) or a
  **PostgreSQL-only limits** section. The four per-engine docs and the
  drizzle-parity array-operator footnote now point to this reference instead of
  restating the explanations, removing the cross-doc duplication.
- Wired the feature-matrix coverage guard into CI (v0.5.0 roadmap item 6):
  `deno task docs:matrix:check` now runs in the `ci` and `publish` workflows,
  and the `pages` build regenerates the matrix before publishing. CI fails if
  the unified matrix marks a `✅`/`⚠️` for an adapter whose suite has no
  correspondingly-named test. With item 2 landed, the `db.batch` "gated
  integration suites" coverage claim is now accurate on all four adapters,
  closing the coverage-honesty gap item 6 was opened for.

## 0.4.0 - 2026-06-30

### Added

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
