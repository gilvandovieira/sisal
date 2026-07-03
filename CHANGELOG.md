# Changelog

This is the canonical changelog for Sisal workspace releases.

The repository starts with an imported baseline commit, `0099bb1`, from the
project Sisal was rebuilt from. That commit is summarized as a baseline instead
of expanded into a full release narrative. The entries below reconstruct the
Sisal-specific history after that baseline through `1f05448`.

## Unreleased

### Security

Resolves every open finding from the 0.9.0 security audit (SEC-008 through
SEC-016; see [`docs/security.md`](docs/security.md)). Each fix is pinned by a
test named for its finding id.

- **SEC-008 (High) — MySQL-family advisory-lock mutual exclusion.**
  `db.tryAdvisoryLock` now verifies ownership by reading the claimed row back
  (owner-token equality) instead of trusting the affected-row count, so it is
  correct on every engine regardless of the driver's found-rows flag. The
  bundled `@sisal/mysql` pools additionally disable `CLIENT_FOUND_ROWS` (mysql2
  `flags: ["-FOUND_ROWS"]`, MariaDB `foundRows: false`) so `tryInsert`'s
  affected-row contract holds for the shipped drivers. **Behavior change:** on
  the MySQL family a plain `UPDATE` that sets a row to its current values now
  reports 0 affected rows (rows _changed_) rather than the number matched — see
  `docs/mysql-compatibility.md`.
- **SEC-009 (Medium) — MySQL/MariaDB TLS.** New `ssl` option on
  `MysqlConnectionOptions` (`boolean | MysqlTlsOptions`), forwarded to mysql2,
  the MariaDB connector, and the migrate driver. TLS-related URL query params
  (`ssl-mode`, `sslmode`, …) are now rejected with a typed error instead of
  being silently dropped (which had connected in cleartext).
- **SEC-010 (Medium) — driver error-property leakage.** `redactErrorCause` now
  recursively sanitizes a preserved driver `cause`: bind/statement properties
  (`parameters`, `sql`, …) are dropped, credential-named properties masked, and
  nested `cause` chains / `AggregateError` recursed. Sisal's own errors pass
  through unchanged.
- **SEC-011 (Low) — redaction gaps.** `redactSecrets` now covers
  `encryptionKey`, URL passwords containing `@`/`/`, and SQL `IDENTIFIED BY '…'`
  / `PASSWORD '…'`; `NeonError` extends `SisalError` (inheriting redaction);
  `SisalError.details` (including `details.sql`) is redacted.
- **SEC-012 (Low) — ETL checkpoint.** `prune` raises the retention horizon
  before deleting source rows (crash-safe under the non-atomic batch fallback);
  `unsafeAllowPrunedReplay` now warns instead of passing silently;
  `etlCheckpoint` fails closed on the `generic` dialect.
- **SEC-013 (Low) — MySQL migration lock.** The default `GET_LOCK` name is
  namespaced by the current database (`sisal:migrate:<db>`), so unrelated
  projects on a shared server no longer contend.
- **SEC-014 (Low) — image pinning.** The `integration.yml` MySQL/MariaDB service
  containers and the example compose images are digest-pinned; a new
  `deno task check:images` (in CI) rejects any unpinned `image:`/`FROM`
  reference; `--no-lock` dropped from the `perf:*` tasks.
- **SEC-015 (Low) — release provenance.** The publish workflow refuses a
  tag-push whose commit is not an ancestor of `main`; the doc tasks the
  pre-commit hook runs use `--allow-run=deno` instead of a blanket
  `--allow-run`.
- **SEC-016 (Low) — core DDL.** `renderPortableExpression` rejects a portable
  DDL expression carrying a bound parameter; index/unique/check constraint names
  are validated as plain identifiers at the core boundary.
- **SEC-007 residual — SQL splitter.** `splitSqlStatements` now handles
  PostgreSQL `E'…'` backslash escapes and nested block comments (correctness on
  trusted migration files).

### Changed

- **Security audit refresh at v0.9.0 (2026-07-02).** `docs/security.md` now
  carries a full re-audit of the surface added since the 0.3.0 audit — the
  `@sisal/core` extraction, the MySQL/MariaDB adapter, the opt-in postgres.js
  driver, and the v0.9 ETL substrate — cross-checked against an independently
  produced second audit and merged. No injection path was found; the refresh
  raises nine open findings: **SEC-008 (High)** — MySQL-family found-rows
  semantics break `tryInsert`/`tryAdvisoryLock` mutual exclusion (empirically
  confirmed on MariaDB 11); **SEC-009 (Medium)** — the MySQL-family URL path
  cannot require TLS and silently drops `ssl-mode` params; **SEC-010 (Medium)**
  — bind values survive in driver-attached error properties; and six Lows
  (SEC-011–SEC-016: redaction gaps, checkpoint prune ordering, server-global
  MySQL migration lock, pinning gaps outside the SEC-002 perimeter, tag-publish
  ancestry + hook permissions, core DDL defense-in-depth). `SECURITY.md` was
  refreshed to the `0.9.x` support line, documents the new
  `db.query`/`db.batch`/checkpoint escape surfaces and the two
  deployment-affecting open findings, and gains a scoped-permission example for
  MySQL/MariaDB migrations.
- **v0.10 roadmap: security-hardening tasks scheduled.** All audit concerns are
  now tracked as `docs/v0.10.0-roadmap.md` tasks **T1–T10** (SEC-008 through
  SEC-016 plus the SEC-007 splitter residual), with per-task fix directions and
  a new acceptance criterion tying the release to closing them; T1 (SEC-008) and
  T5 (SEC-012) are called out as hard prerequisites of the ETL runner's
  lock-serialization and checkpoint/replay acceptance criteria. The master
  `docs/roadmap.md` v0.10 row and the `docs/security.md` findings table
  cross-reference the task IDs.
- **v0.10 roadmap: v0.9 Phase 6 deferrals triaged.** The seven items v0.9 left
  _explicitly deferred_ are now tracked in `docs/v0.10.0-roadmap.md` as tasks
  **CF1–CF7**. Three are scheduled into v0.10 as active work — CF1
  (`postgres.js` as the default `@sisal/pg` driver + upstream `setNoDelay` fix),
  CF2 (materialized-view Postgres rollup acceleration, investigate→build), and
  CF3 (recursive-CTE `CYCLE`/`SEARCH`) — while CF4–CF7 (MySQL binary protocol,
  typed `CREATE FUNCTION`, transformable AST, npm dual publish → v0.13+) stay
  recorded but deferred past v0.10 per the release-sequencing discipline. The
  v0.9 Phase 6 section links forward to the CF task IDs.
- **v0.10 roadmap: ETL feature tasklist drawn up.** The `@sisal/etl` build work
  — the release headline — is now tracked as tasks **T11–T23** in
  `docs/v0.10.0-roadmap.md`, derived from the scope, execution model, and
  acceptance criteria: package scaffold (T11), `defineJob` (T12), the `rollup()`
  pushdown SQL (T13), checkpoint store (T14), window computation (T15), the
  `run()` single-window runner (T16), `backfill`/`replay`/`status` (T17–T19),
  `dry-run`/`explain` (T20), capability-gating (T21), scheduler docs (T22), and
  the `post_events → post_hourly_stats` example + integration suite (T23). Each
  task consumes the v0.9 ETL substrate (checkpoint contract, portable lock,
  atomic load+advance, `WriteOutcome`) rather than reinventing it, and the
  acceptance criteria now cite the tasks that discharge them.

### Added

- **Portable write-outcome — `tryInsert` / `WriteOutcome` (v0.9 T15).** A
  reliable **inserted-vs-conflicted/claimed** signal for a conflict-guarded
  insert (`tryInsert(db, insert)` where you supply `.onConflictDoNothing()`),
  since `rowCount` alone can't distinguish across engines under the portable
  MySQL no-op `ON DUPLICATE KEY UPDATE`. It reads the signal per dialect:
  `RETURNING` on the Postgres and SQLite families (a row comes back iff the
  insert won), the affected-row count on the MySQL family (no usable `RETURNING`
  on a no-op upsert; 1 on insert, 0 on conflict). Fails closed on `generic`. The
  advisory-lock claim (T11) now consumes it, so claimed-vs-not is reliable
  across engines rather than the previously ambiguous `rowCount >= 1`. Backed by
  5 network-free unit tests, a per-engine integration scenario, and a
  `docs/feature-matrix.md` row. Completes the v0.9 ETL correctness substrate.
- **Retention horizon + replay refusal on the checkpoint (v0.9 T14).** Extended
  the `etlCheckpoint` handle with the mirror of `advance`:
  `prune(before,
  deletes)` upserts the per-job `pruned_before` **retention
  horizon** in the **same `db.batch`** as the source-delete statements, so the
  horizon advances atomically with the delete and never lags it (a crash rolls
  both back together). `assertReplayable(from, options?)` throws a typed
  `ORM_REPLAY_PRUNED` error when a replay window begins before the horizon
  (`from < pruned_before`) — replaying over pruned source rows would silently
  overwrite the rollup with missing data — with an explicit
  `unsafeAllowPrunedReplay` override mirroring `.unsafeAllowAllRows()`. TEXT
  watermarks compare lexicographically, so `from >=
  pruned_before` is the
  replayable boundary. Backed by 13 network-free unit tests and a per-engine
  integration scenario proving both directions (a refused replay leaves the
  rollup untouched; a failing prune rolls delete + horizon back together), plus
  a `docs/feature-matrix.md` row.
- **Checkpoint contract validation + `Checkpoint.readState()` (v0.9 T13).**
  Added `readState()` to the `etlCheckpoint` handle — the full
  `{ windowEnd, prunedBefore, updatedAt }` contract row (the `window_end`-only
  `read()` stays the shortcut; `readState()` also feeds the T14 retention
  horizon). Per-engine integration scenarios validate the checkpoint contract on
  every ETL target: exact TEXT round-trip fidelity (a precise ISO watermark
  reads back byte-identical, no timestamp coercion), multi-job independence,
  that `updated_at` is written, and resume from a fresh handle.
  `docs/architecture.md` records that the A3 ownership decision held — the
  checkpoint (and advisory lock) substrate ships in `@sisal/orm`, its system
  tables are runtime-managed, and there is **no `etl → migrate` edge**. Because
  watermarks are TEXT, the contract's anticipated "adapter-specific timestamp
  type" reconciliation is not needed.
- **ETL checkpoint substrate — `etlCheckpoint(db, job, options?)` (v0.9 T12).**
  A standalone factory (mirroring `defineAtomicOperation`) for the resumable
  watermark table `sisal_etl_checkpoints` (the v0.6 A3/A4 / contract-09
  substrate a future ETL runner consumes). `read()` returns the last committed
  `window_end` watermark (or `null` on a fresh job); `advance(until, load)` runs
  the caller's idempotent load and the watermark upsert as **one `db.batch`**,
  so they commit together — the **atomic load+advance invariant**: a crash never
  advances the watermark past data that was not written. Watermarks are stored
  as **opaque TEXT** (ISO-8601 by convention; the caller owns the meaning),
  which keeps the checkpoint uniform across all six engines with no per-adapter
  timestamp-decode divergence; the table (override the name with `{ table }`,
  created on first use) already carries the nullable `pruned_before` column for
  the retention horizon. `CREATE TABLE IF NOT EXISTS` runs outside the atomic
  batch (MySQL auto-commits DDL). Backed by 7 network-free unit tests and a
  per-engine idempotent-resume + crash-safety integration scenario, plus a new
  `docs/feature-matrix.md` row. See
  `examples/advanced-sql-contracts/09-idempotent-backfill.md`.
- **Portable advisory lock — `Database.tryAdvisoryLock(name, options?)` (v0.9
  T11).** A coarse, whole-job mutual-exclusion primitive (the v0.6 A2 /
  contract-08 substrate a future ETL runner consumes so two runs never process
  the same window twice), implemented as a **lightweight lock-row lease**: the
  claim is one row in `sisal_advisory_locks` (default table name; override with
  `{ table }` — Sisal never forces its name into your schema) carrying an
  ISO-8601 lease, so **no connection or server-side lock is held** between
  acquire and release and work proceeds on the normal pool.
  `await using lock =
  await db.tryAdvisoryLock(...)` releases on scope exit
  (including on a throw); `lock.acquired` reports whether the claim won;
  `lock.renew()` extends the lease and returns `false` when it was lost/stolen.
  Uniform across all six engines (plain, dialect-rendered DML — no driver or
  adapter changes); fails closed on the `generic` dialect
  (`ORM_DIALECT_UNSUPPORTED`). A crashed holder's lease expires after `ttlMs`
  (default 30s) and may then be stolen, so long runs should `renew()` and stop
  on a `false`. Backed by 10 network-free unit tests, a per-engine contention
  integration scenario on every ETL target, and a new `docs/feature-matrix.md`
  row. Chosen over per-dialect session-scoped native locks (`pg_advisory_lock` /
  `GET_LOCK` / `BEGIN IMMEDIATE`) so a held lock does not pin a session for the
  whole run; see `examples/advanced-sql-contracts/08-job-queue-locking.md`.
- **Concrete logging integration example.** Added `examples/logging`, a
  driverless runnable example showing separate `@std/log` and Pino adapters for
  Sisal's `Logger` contract, including structured logging at `trace` with
  redacted bind-parameter summaries.
- **Hibernate-style logging verbosity controls.** Added shared
  `SisalLoggingOptions` / `SisalLogSettings` with severity thresholds, category
  overrides, optional `trace`, and safe redacted SQL bind summaries. ORM and
  migration facades now accept `logging` beside the legacy `logger`; `logger`
  alone keeps the previous behavior without bind logs. The migration CLI accepts
  `--log-level`, `--quiet`, and repeatable `-v`/`--verbose`, and
  `defineConfig({ logging })` can provide default CLI logging settings. The work
  is recorded as a v0.9 hardening/observability lane in
  `docs/v0.9.0-roadmap.md`.
- **`await using` support on `Database` and `Migrator`.** Both now implement
  `Symbol.asyncDispose` as an alias for `close()`, so
  `await using db = await connect(...)` (and `createMigrator(...)`) release the
  connection/pool and store at scope exit — including on an early throw — with
  no `try/finally`. Additive and non-breaking; `close()` stays the source of
  truth. Adapter databases inherit it through `extends Database`, and the
  adapter migrator facades (`createPgMigrator` / `createSqliteMigrator` /
  `createLibsqlMigrator` / `createMysqlMigrator`; Neon inherits via
  `NeonMigrator = PgMigrator`) expose the same alias, each with an `await using`
  disposal test. The README PostgreSQL walkthrough uses the `await using` form.
  Recorded as a v0.9 lane in `docs/v0.9.0-roadmap.md`.
- **MySQL functional (expression) indexes light up on MySQL 8.0.13+ (v0.9 T8).**
  Added a `functionalIndex` `DialectCapability`
  (`unsupported: ["mysql"],
  unless: [{ baseEngine: true, minVersion: "8.0.13" }]`)
  and threaded a `DialectIdentity` (built from the snapshot's
  `dialectVariant`/`dialectVersion`) through the `@sisal/mysql` DDL generator.
  An expression index now emits `((expr))` on base MySQL ≥ 8.0.13 and throws a
  typed `ORM_DIALECT_UNSUPPORTED` guard below that version, on MariaDB, and when
  the version is unknown (fail-closed); partial (`WHERE`) indexes stay
  unsupported family-wide. Covered by new `ddl_test.ts` render/throw cases; the
  feature-matrix reason is updated.
- **Typed `numeric`/`bigint` round-trip integration scenarios (v0.9 T6).** The
  shared integration harness gains a `valueShape.bigint` descriptor (`"string"`
  on the Postgres + MySQL/MariaDB families, `"number"` on the SQLite family),
  and each of the three family scenario files gains a `numeric + bigint`
  round-trip that asserts the decoded `typeof` against the descriptor. The
  string families use an int8 above 2^53 (`9007199254740993`) to prove no
  lossy-float path; the SQLite family stays under 2^53 and documents the
  precision limit. DB-gated (type-checked across all six suites; runtime
  assertions await a live run).

### Fixed

- **Recursive CTEs (`db.$withRecursive`) rendered invalid SQL for the common
  tree-walk shape (v0.9 T17).** Writing the recursive step as
  `.from(base).innerJoin(base, … self …)` — the form shown in the docs and
  pinned by the render tests/golden snapshot — rendered the recursive term
  **absent from the FROM** (`from "posts" inner join "posts" … "tree"."id"`),
  which every engine rejects (`table name specified more than once` /
  `missing FROM-clause entry`). The correct form puts the self-reference in the
  FROM: `.from(self)`. This shipped because there was **no recursive-CTE
  integration coverage** (added in v0.9). A new **build-time guard** now throws
  `ORM_INVALID_QUERY` when a recursive step never uses its self-reference as a
  FROM source, so the mistake fails loudly at build time instead of producing
  broken SQL. The render tests, golden snapshot, and examples now use
  `.from(self)`.
- **Prepared queries now render with the full dialect identity.**
  `Select/Insert/Update/Delete.prepare()` baked the plan with the bare
  `database.dialect`, dropping the `variant`/`version` the normal execute path
  threads through. On a detected MariaDB (or any version-gated) connection a
  prepared statement rendered as plain MySQL, so variant/version-gated
  constructs failed closed — e.g. `insert(...).returning().prepare()` threw
  "INSERT … RETURNING is not supported by the mysql dialect" even though the
  same query executes fine via `.execute()`. Both `prepareRows`/`prepareResult`
  now pass `database.dialectIdentity`; regression-guarded by a new
  prepared-query test in `packages/orm/dialect_identity_test.ts`.

### Changed

- **Advanced-SQL example families migrated to builder-native (v0.9 T19).** All
  three families — `examples/{postgres,mysql,sqlite}-family-advanced-sql` — now
  express their graduated contracts through the query builder instead of raw
  `sql` templates, each statement render-verified against its original raw SQL
  for equivalence. The classification below is the PostgreSQL family; MySQL and
  SQLite mirror it, differing only in the inline fragments kept for dialect
  divergences (MySQL `timestampdiff`/date math; SQLite `julianday`/`date()` and
  `json_each`/`json_extract` for JSON), and SQLite un-skips contracts 03/05/06
  (previously `skipped` in that conservative file). Contracts 02 (window
  analytics) and 04 (top-N per group) are fully **builder** —
  `over()`/`rank()`/`rowNumber()` windows with a ROWS frame and a `.as()`
  derived table. Contracts 03 (sessionization), 05 (cohort retention), 06
  (funnel analysis), 07 (recursive comments), and 10 (JSON table extraction) are
  **hybrid**: `$with()`/`$withRecursive()` CTEs, `lag()`/`sum()` windows,
  `min()`/`countDistinct()`/`filter()` aggregates, `dateTrunc()`, and
  `jsonTable()` supply the structure, with inline fragments kept only for the
  un-expressible bits (PostgreSQL `::interval` gap/deadline math whose exact
  boundary `dateDiff()`'s whole-unit truncation cannot reproduce, the CTE-to-CTE
  join, the lateral cross-join composition, and `lpad`/`||`/`::text` path
  expressions). Contract 11 (generated columns + indexes) now emits its DDL from
  a `defineTable()` snapshot — a stored generated column plus a partial
  expression index — through the PostgreSQL DDL generator rather than
  hand-written SQL (still `raw-ddl`). Stale `v08PainPoint` notes were rewritten
  to describe the now-shipping builder behavior; render-test assertions were
  updated to the equivalent builder-rendered SQL. Contracts 01/08/09 stay as-is.
- **Compatibility docs + unified matrix refreshed to the v0.9 reality (T20).**
  `docs/feature-matrix.md` (generated) now carries the v0.9 rows — advisory
  lock, ETL checkpoint watermark, retention/replay refusal, write outcome, and
  read/recursive CTE — each scenario-backed. Each of the five
  `docs/*-compatibility.md` gained a **v0.9 additions** note covering the
  portable ETL substrate (`tryAdvisoryLock`/`etlCheckpoint`/`tryInsert`, with
  the per-engine write-outcome mechanism), read/`WITH RECURSIVE` CTE coverage,
  and the PostgreSQL/Neon-only data-modifying CTE. The dated "last live run"
  attestation tables are unchanged — the v0.9-added integration scenarios are
  DB-gated and await the next live run.
- **Refreshed the API reference for the current workspace.** `docs/api.md` now
  reflects the v0.8 package split (`@sisal/core` as the driverless compile
  target), the MySQL/MariaDB adapter package, current subpath exports, query
  builder additions, logging controls, async disposal aliases, schema-object
  snapshots, and adapter DDL/migration boundaries.
- **v0.9 roadmap priority summary** — `docs/v0.9.0-roadmap.md` gains the
  consolidated T1–T20 task table in the v0.5–v0.8 style, separating active v0.9
  scope from the detailed phased execution tasklist and explicitly marking the
  v0.10-critical capability/ETL substrate path.
- **Corrected the row-locking row in the feature matrix.** The generated
  "PostgreSQL-only limits" prose for `.for(...)` reused the shared pg-only tail
  and wrongly claimed the MySQL family throws; row locking is unsupported on the
  SQLite family only (MySQL/MariaDB render `FOR UPDATE`/`FOR SHARE` natively, as
  the table already showed). Fixed the `LOCKING` reason in
  `tools/feature_matrix.ts` and regenerated `docs/feature-matrix.md`.
- **Feature-matrix cells derive from the capability registry (v0.9 T3).** The
  pure supported/unsupported rows (`distinctOn`, row locking, array operators,
  data-modifying CTE) now compute their ✅/❌ cells from
  `capabilitySupported(...)` over `DIALECT_CAPABILITIES` via a `capabilityRow`
  helper, so they cannot drift from the render-time guards. Output is
  byte-identical (`docs:matrix:check` unchanged); value-shape ⚠️ and fallback
  rows stay hand-authored.
- **Dialect key spaces reconciled + machine-checked (v0.9 T4).** Added a runtime
  `SQL_DIALECTS` companion to the `SqlDialect` type and a reconciliation test
  that pins the render dialect, the snapshot `SisalDialectName`, and the six
  `CAPABILITY_TARGETS` as projections of the one `(engine, variant, version)`
  descriptor: the 4-way unions are asserted identical at compile time, the 6→4
  collapse (neon→pg, libsql→sqlite, mariadb→mysql) is verified, and capability
  declarations naming an unknown dialect/variant are rejected. No behavior
  change.
- **Network-free regression test for `@sisal/pg` float decoding (v0.9 T5).** The
  float4/float8 → `number` coercion shipped in v0.5.0 but was covered only by
  the DB-gated integration suite; added a fast unit test (`packages/pg/orm/`)
  that drives the coercion through a fake client and asserts `numeric` stays a
  string. No behavior change.
- **Partial-index limit promoted to a registry capability (v0.9 T9).** Added a
  `partialIndex` `DialectCapability` (`unsupported: ["mysql"]`); the
  `@sisal/mysql` DDL generator now sources its partial-index (`WHERE`) rejection
  from `capabilitySupported(...)` instead of a hard-coded throw, so the fact is
  single-sourced with the render guards. The matrix note records that Sisal
  emits plain `CREATE INDEX` for every dialect (no `IF NOT EXISTS`). No behavior
  change; the MySQL/MariaDB `RETURNING` capability rows were already complete.
- **Base-engine-scoped version predicates in dialect guards (v0.9, unblocks
  T8).** `DialectGuardException` gains `baseEngine?: boolean`; when set, the
  `unless` lift applies only to an identity with **no variant** (the base
  engine). This makes "supported on base MySQL ≥ 8.0.13 but never MariaDB"
  expressible — previously a variant-less `unless` lifted every variant, so
  MariaDB 11.x (numerically ≥ 8.0.13) would wrongly clear a MySQL version floor.
  Covered by the render guard and `capabilitySupported` in
  `packages/orm/dialect_identity_test.ts`.
- **`@sisal/pg` decodes `bigint`/int8 as a string, aligning the Postgres family
  (v0.9 T7).** int8 previously decoded to a JS `BigInt` on `@sisal/pg` but a
  `string` on `@sisal/neon`, so an `id === "2"` check silently diverged between
  the two Postgres-family adapters. The pg executor now coerces int8 columns
  (OID 20) to strings — matching neon and preserving 64-bit precision — via
  `coercePgColumns` (renamed from `coerceFloatColumns`; float4/float8 → `number`
  coercion is unchanged). Pinned by a network-free executor unit test (proven to
  bite) and the cross-adapter parity test (both adapters assert
  `typeof === "string"` and equal values). **Migration note:** code that relied
  on pg returning a `BigInt` (e.g. `row.id === 2n`) must compare as strings.
- **Clarified `db.batch` round-trip wording.** The `OrmDriver.batch` contract
  and the `#runBatch` comment implied single-round-trip execution; the built-in
  pg/mysql/sqlite/libsql adapters run the statements sequentially inside one
  atomic transaction. Reworded so a single round trip is described as an
  optional driver capability, not a guarantee. (libSQL's native one-round-trip
  `batch()` remains an available future optimization.)

- **Overhauled the benchmark suite to track only Sisal's own hot paths.** The
  `temporal` scenarios drop the `Date`-vs-`Temporal` runtime-API microbenchmarks
  (`date api parse` / `date api format`) and the raw-JS mapping baselines — none
  of them exercise Sisal code, so they carried no regression signal — keeping
  the Sisal serialization (`sisal temporal params`) and parse-cost
  (`sisal temporal row parsing`) groups. The migration scenarios drop the
  `deno eval` subprocess smoke bench (it timed Deno process startup, not Sisal),
  so `deno task bench` no longer needs `--allow-run` and its group is renamed
  `cli + migrations` → `migrations`. `docs/benchmarks.md` is updated to match.
  The SQL-generation, advanced-SQL, and fake-driver dispatch scenarios are
  unchanged.

### Removed

- **Dropped the Sisal-vs-Drizzle comparison benchmarks.** Removed the
  `vs_drizzle`, `vs_drizzle_execute`, and `drizzle_proxy` benchmark scenarios,
  the `drizzle-orm` import map entries in `benchmarks/deno.json`, and the fake
  proxy's Drizzle adapter (`asDrizzlePgProxy` and its helpers/tests). Benchmarks
  now measure Sisal's own SQL generation, dispatch, and result mapping in
  isolation. `docs/benchmarks.md` drops the head-to-head sections accordingly.
  The Drizzle **parity** matrix and its tests are unaffected.

## 0.8.0 - 2026-07-02

### Added

- **v0.8 final items closed — 14/15/19 + capability-matrix wiring (item 1)**,
  each verified live on PostgreSQL 16, MySQL 8.4, MariaDB 11.8, and embedded
  SQLite:
  - **Generated columns (item 15)** — the generated-column builder declares
    `GENERATED ALWAYS AS (…)` columns as either stored or virtual. The metadata
    flows through the schema snapshot (change-detected in the diff) and the
    PostgreSQL/SQLite/MySQL DDL generators. Virtual generated columns fail
    closed with a typed error on PostgreSQL (STORED-only), and a generated
    column cannot also carry a default. Expression and partial indexes were
    already snapshot/DDL-native.
  - **Array / JSON / set-returning IR (item 14)** — `arrayExpr` (`ARRAY[…]` /
    `json_array`), `jsonExtract` (portable scalar JSONPath extraction), and
    `jsonTable` — a set-returning FROM source compiling to PostgreSQL
    `jsonb_to_recordset`, MySQL `JSON_TABLE`, and SQLite `json_each` + per-field
    `json_extract`, with typed column refs. The select builder gains a raw-`Sql`
    `.from(...)` overload (a set-returning/table-valued FROM fragment), which
    also composes with `assembleSelect`.
  - **ODKU assignment-order safety (item 19)** — `onConflictDoUpdate` set
    assignments render in author order verbatim, and the MySQL render throws a
    typed guard when an assignment reads a _different_ sibling column set
    earlier in the same list (the left-to-right footgun that silently diverges
    from PostgreSQL). Self-references, derived-first, and `excluded()` pass; the
    policy is documented in `docs/portability-policies.md`.
  - **Capability descriptor / matrix (item 1)** — the feature-matrix generator
    now consumes the core registry's `CAPABILITY_TARGETS`, and
    `deno task docs:matrix:check` fails if the matrix `ADAPTERS` and the
    registry's six-way target space diverge (the GI-1 key-space reconciliation).
    Per-cell capability-value wiring remains a v0.9 item.

  All 19 v0.8 roadmap items are now complete.

### Changed

- **Advanced-SQL contract review + roadmap logging** — reviewed the
  `examples/{postgres,mysql}-family-advanced-sql` families against
  `examples/advanced-sql-contracts/` after v0.8 waves 0–4. Rebuilding each
  `"raw"` case with the shipped primitives confirmed contracts **01–07** and the
  expression/partial-index half of **11** are now builder-native; the finding is
  recorded in the [v0.8 roadmap](docs/v0.8.0-roadmap.md) graduation section.
  Three still-open concerns were logged into [v0.9](docs/v0.9.0-roadmap.md):
  version-gating MySQL functional indexes (≥ 8.0.13, currently fail-closed
  always), refreshing the advanced-SQL example families to builder-native, and
  the recursive-CTE `CYCLE` cycle-detection question. (JSON-table, generated
  columns, and the ODKU assignment-order hazard remain tracked as v0.8 items
  14/15/19.)

- Bumped every workspace manifest (`packages/`, `examples/`, and `benchmarks`)
  to `0.8.0`, and updated the migration CLI's default adapter imports plus
  README install snippets to point at the v0.8 package line.

### Added

- **Wave-4 proof and stamp (v0.8 items 3/5/8/13/17)** — the release's acceptance
  proofs and the frozen-surface documentation:
  - **Statement assembly** (`@sisal/core`'s new `assembleSelect` /
    `assembleInsertFromSelect`, with the dialect-mapped upsert) implements the
    item-5 seam decision. The **core-only rollup fixture**
    (`packages/core/rollup_fixture_test.ts`) compiles the canonical v0.6
    `post_hourly_stats` rollup — grouped insert-from-select + `FILTER`
    aggregates + `dateTrunc` + upsert — using only `@sisal/core` exports, and
    `packages/orm/assembly_equivalence_test.ts` proves assembly and the fluent
    builder render **byte-identical text and parameters on every dialect**, so
    the two surfaces cannot drift.
  - **`SQL_IR_VERSION = 1`** is exported and `docs/core-ir.md` documents the
    compile-target contract: the three export surfaces and their commitments,
    the `SqlChunk` kind table with render semantics, the compatibility policy
    (additive changes are minor; the `meta` slot is the reserved AST seam; the
    golden suites are the behavioral pin), and what is deliberately not
    promised.
  - **`docs/portability-policies.md`** states the cross-family policies once:
    the MySQL-family UTC literal policy ("executor UTC convention"), the
    `dateTrunc`/`dateBin`/`dateDiff` value-shape table with the
    compare-within-one-engine rule, and the no-transactional-DDL cleanup
    pattern.
  - Item 8 closes with golden-pinned scalar subqueries in projections; the
    golden suite grows to **59 snapshots** (all prior keys byte-identical), and
    `benchmarks/scenarios/advanced_sql.ts` adds render-throughput baselines for
    the wave-3/4 constructs.

- **Wave-3 expression surface in `@sisal/core` (v0.8 items 7/9/10/11/12)** —
  every semantic verified live on PostgreSQL 16, MySQL 8.4, MariaDB 11.8, and
  embedded SQLite with identical values before pinning:
  - **`expr<T>()`** types a fragment as a `SqlExpression<T>` — the name-once
    handle for computed/metric expressions, replacing `as SqlExpression<T>`
    casts; reuse across projection/`groupBy`/`having`/`orderBy` is pinned.
  - **`coalesce`**, **`greatest`/`least`** (SQLite renders scalar `max`/`min`;
    per-engine NULL divergence documented) retire the last raw seams in the
    composed rollups.
  - **Window primitives** (`core/window.ts`): `over()` with
    `WindowSpec`/`WindowFrame`/`FrameBound` per the analytics-readiness
    signature, plus `rank`/`denseRank`/`rowNumber`/`lag`/`lead`, and
    **`dateDiff`** (truncated whole units; `TIMESTAMPDIFF` / epoch-`trunc` /
    `julianday` per family). Two new registry capabilities: `GROUPS` frames
    (MySQL family unsupported; SQLite version-gated ≥ 3.28 through the new
    **dialect-scoped guard exception** — `DialectGuardException.dialect` extends
    the item-1 key space) and the `lag()`/`lead()` **default argument**, which
    the live probe caught MariaDB 11.8 rejecting (MySQL 8.4 accepts it) —
    guarded typed; portable spelling `coalesce(over(lag(x), …), d)`.
  - **Recursive CTEs**:
    `db.$withRecursive(name, columns).as((self) =>
    base.unionAll(step))`
    renders `WITH RECURSIVE name (cols) AS (…)` with the self-reference usable
    as a source, one `RECURSIVE` keyword covering mixed plain/recursive lists,
    and the portable depth-guard pattern.
  - The golden baseline suite grew to **57 snapshots** (six new constructs × 5
    render targets), with all 51 pre-existing keys byte-identical — closing
    item 12.

- **`@sisal/core` extracted (v0.8 wave 2, item 2)** — the new `packages/core`
  package is Sisal's driverless compile target: schema primitives and snapshots
  (`./schema`), the fragment SQL IR and `sql` tag, expression operators and
  aggregates, the dialect capability registry, the dialect-aware renderer,
  structured errors, and the `Logger` contract — everything
  `@sisal/etl`/`@sisal/analytics` will compile into without depending on the
  ORM. The fluent query builders, `Database` facade, relations, and typed
  function caller stay in `@sisal/orm`, which re-exports the full core surface;
  `@sisal/orm/core`, `/schema`, `/error`, and `/logger` remain as compatibility
  re-exports, so **no user-visible imports change** (proven by the
  byte-identical golden baselines and the full unit suite). The ORM's builder
  tier reaches non-public core plumbing only through the documented-unstable
  `@sisal/core/unstable-internal` seam. `@sisal/migrate` now depends on
  `@sisal/core` only (the wave-1 decision, item 6), with the import mapping
  recorded in `docs/core-migration.md`. JSR publish dry-run passes for all eight
  workspace packages (`@sisal/core@0.8.0`).

- **Core capability registry — the `(engine, variant, version-range)` key space
  (v0.8 wave 1, item 1)** — new core module `capabilities.ts` (in
  `packages/core/` since the wave-2 extraction): `DIALECT_CAPABILITIES` declares
  every render-guarded construct's dialect truth (per-statement `RETURNING` with
  MariaDB floors, `distinctOn`, `FULL JOIN`, row locking, array operators,
  data-modifying and mutation-prefixed CTEs, `DELETE … USING`, multi-table
  `RETURNING`) as the same serializable data the render-time `guard` chunk
  carries. Every guard call site now derives its guard from the registry
  (`capabilityGuard`), and the new `capabilitySupported`/`dialectGuardApplies`
  predicates answer support questions without rendering, with identical
  fail-closed semantics — the registry and renderer cannot disagree (pinned by
  `capability_test.ts`; the wave-0 golden baselines are byte-identical).
  `CAPABILITY_TARGETS` names the six capability targets
  (`pg`/`neon`/`sqlite`/`libsql`/`mysql`/`mariadb`) as `(engine, variant)`
  identities. Feature-matrix generation wiring is v0.9 work.

- **Additive IR extension seam (v0.8 wave 1, item 4)** — `SqlChunk` gains an
  opaque, renderer-ignored `meta` slot (`SqlChunkMeta`, `withSqlChunkMeta`,
  `sqlChunkMeta`): annotations attach to fragments, ride through `sql`-tag and
  builder composition by reference, and never change rendered output — proven by
  the round-trip fixture `sql_meta_seam_test.ts`. This is the reserved seam that
  lets a future transformable AST (v0.13 DuckDB pushdown) arrive as a
  non-breaking version bump, closing the sequencing audit's Fix 3.

- **v0.8 wave-1 decisions recorded** (roadmap open questions): the statement
  assembler will be a **minimal assemble-from-parts API in `@sisal/core`** (the
  fluent OLTP builder stays in `@sisal/orm`); `@sisal/migrate` will depend on
  **core only**; the ETL checkpoint table stays **`@sisal/etl`-managed** (no
  `etl → migrate` edge — audit Fix 2 ratified); the write-result ("inserted vs
  conflicted/claimed") abstraction direction is recorded with implementation
  deferred to ride with v0.9's queue-claim work.

- **Golden per-dialect SQL baselines (v0.8 wave 0, item 12 first half)** — new
  network-free snapshot suite `packages/orm/golden_sql_test.ts` pins the
  rendered SQL of every existing IR construct (49 constructs: selects,
  operators, joins, aggregates + `filter()`, keyset both forms, compounds, CTEs
  incl. data-modifying bodies and `WITH`-on-mutation, date helpers, the `sql`
  tag, `db.call`, inserts/upserts/updates/deletes with returning/multi-table
  forms) across 5 render targets (postgres/sqlite/mysql/generic + the detected
  MariaDB 11.8.8 identity), recording exact text, ordered params, and typed
  guard errors, plus per-dialect prepared-plan placeholder styles. These
  snapshots are the behavior-preservation net for the upcoming v0.8
  `dialectGuard` generalization and `@sisal/core` extraction. Adds
  `@std/testing` (snapshot) as a dev import.

- **v0.8 roadmap priority summary** — `docs/v0.8.0-roadmap.md` gains the tracked
  task list (19 numbered items with priority/effort/status, the v0.5 table
  style): the IR-freeze spine (capability-descriptor key space, `@sisal/core`
  extraction, versioned IR surface, the AST additive seam, the
  statement-assembly decision), the expression-surface work surfaced by the
  example graduations (aliases, computed columns, `coalesce`/`greatest`,
  windows + date-diff helpers, recursive CTEs, the ODKU assignment-order
  hazard), the golden-SQL/core-only-fixture proofs, and the audit-mandated
  decisions (checkpoint-table ownership). Consolidated from the v0.5/v0.6/v0.7
  handoffs, both v0.8 findings sections, and the roadmap sequencing audit's v0.8
  gates (Fixes 1–4). An **execution-order section** gives the
  dependency-compatible five-wave build sequence (golden baselines first as the
  refactor net, freeze-shaping decisions, the extraction, the expression
  surface, then the fixture/stamp), since the item numbers are tracking IDs, not
  a build order. A follow-up consistency pass across
  v0.8/v0.9/v0.11/analytics-readiness standardized the capability-descriptor key
  naming on `(engine, variant, version-range)` (the v0.7 `DialectIdentity` axis
  generalized), acceptance-gated the statement-assembly and `@sisal/migrate`
  dependency decisions, settled the window-primitive boundary (grammar-level
  `over()`/frames/`rank`/`lag`/`lead` are core; the semantic layer is
  analytics), assigned the recursive CTE builder to v0.8 with v0.9 doing
  per-engine verification, recorded that `@sisal/orm/core` stays as a
  compatibility re-export of `@sisal/core`, and fixed the stale "first new
  package boundary" wording (v0.7 already shipped `@sisal/mysql`).

- **MySQL/MariaDB CI integration jobs** — the scheduled `Integration` workflow
  now runs the gated mysql-family suites against service containers:
  `integration/mysql_features_test.ts` on `mysql:8.4` and
  `integration/mariadb_features_test.ts` on `mariadb:11`, closing the v0.7 B8
  `.github/workflows` deliverable so the MySQL/MariaDB feature-matrix columns
  are CI-backed, not local-only.

- **Advanced SQL contract graduation examples** - new runnable workspace
  packages `examples/postgres-family-advanced-sql`,
  `examples/mysql-family-advanced-sql`, and
  `examples/sqlite-family-advanced-sql` turn the Markdown advanced-SQL contracts
  into generation-first examples with focused render tests. They use Sisal
  builders for ETL rollups and row locking where possible, safe parameterized
  `sql` for engine-supported gaps such as windows, recursive CTEs, JSON-table
  extraction, generated columns, and richer indexes, and explicit typed/skipped
  cases for MySQL `RETURNING`, MySQL partial indexes, and conservative SQLite
  coverage. The v0.8 roadmap now records every missing primitive and dialect
  pain point exposed by the graduation.
- **MySQL-family showcase + rising-feed examples (v0.7 follow-through)** —
  `examples/mysql-family-showcase` and `examples/mysql-family-feed` complete the
  MySQL-family side of the dialect-family example taxonomy. The showcase is
  generation-first (zero database setup) and prints MySQL DDL, migration diffs,
  MySQL-rendered builder SQL, `ON DUPLICATE KEY UPDATE`, and typed guards for
  unsupported `RETURNING`; with `MYSQL_URL`/`MARIADB_URL`/`DATABASE_URL`, it
  also runs a compact live tour over `mysql2` or the MariaDB connector. The feed
  ports the `/rising` product example to MySQL/MariaDB with `varchar(36)` UUID
  keys, UTC `DATETIME(6)` literals, row-value keyset pagination, TypeScript and
  builder-CTE recompute paths, and gated MySQL/MariaDB live tests. The v0.8
  roadmap now records the concrete IR/API pressure points this construction
  exposed.
- **MySQL CLI target + basic example (v0.7 B9)** — `sisal init --target mysql`
  now scaffolds a `dialect: "mysql"` migration config with
  `MYSQL_URL ?? DATABASE_URL` connection hints; `mariadb` is an alias for the
  same adapter target. The CLI default adapter loader resolves
  `@sisal/mysql/ddl` and `@sisal/mysql/migrate` for `generate`, `migrate`,
  `status`, and `drift`. New runnable workspace example
  `examples/mysql-family-basic` prints generated MySQL DDL without a database
  and, when pointed at a URL, runs a tiny create/insert/count flow over either
  `mysql2` or the MariaDB connector via `SISAL_ADAPTER`.
- **MySQL multi-table mutation joins (v0.7 B10)** — existing portable builders
  now render MySQL-family multi-table forms: `update(t).from(source)` maps to
  `UPDATE t, source SET t.col = … WHERE …`, and `delete(t).using(source)` maps
  to `DELETE FROM t USING t, source WHERE …`. PostgreSQL/SQLite `UPDATE … FROM`
  rendering is unchanged; SQLite `DELETE … USING` stays a typed guard.
  Multi-table mutation plus `.returning()` remains guarded for the MySQL family,
  including MariaDB, because the proven B7 `RETURNING` support is
  per-statement/single-table. The shared mysql-family integration scenario now
  exercises `UPDATE FROM`, `DELETE USING`, and `INSERT SELECT`, and the feature
  matrix marks MySQL/MariaDB mutation joins as fully tested.
- **`@sisal/mysql` integration suite + feature-matrix columns (v0.7 B8)** — the
  reserved `"mysql"` slot in the consolidated integration structure is filled:
  **42 shared mysql-family scenarios**
  (`integration/_shared/mysql_family_scenarios.ts`) run green against **both**
  engines — `integration/mysql_features_test.ts` on MySQL 8.4.10,
  `integration/mariadb_features_test.ts` on MariaDB 11.8.8 (also passing on the
  opt-in mariadb driver), gated by `SISAL_MYSQL_IT=1` / `SISAL_MARIADB_IT=1`.
  One adapter, two capability profiles: scenarios branch on the target's
  declared capabilities, so each divergence is a tested fact (MySQL's
  `.returning()` throws the typed guard and the B7 `insertReturning`
  fetch-by-key strategy carries the insert; MariaDB's auto-detected identity
  lights `INSERT`/`DELETE … RETURNING`; `UPDATE … RETURNING`, `FULL JOIN`,
  `distinctOn`, dm-CTEs, and partial/expression indexes assert their typed
  guards live). The cross-driver feature matrix gains **`MySQL` and `MariaDB`
  columns** (MariaDB is a distinct profile, not a footnote — 36 features × 6
  adapters, every ✅/⚠️ scenario- backed), `docs/mysql-compatibility.md` is the
  new per-engine page, and the homepage `#compat` section gains both badges. The
  row-value keyset path is confirmed working live (both keyset forms paginate
  identically).

### Changed

- Bumped every workspace manifest (`packages/`, `examples/`, and `benchmarks`)
  to `0.7.0`, and updated the migration CLI's default adapter imports plus
  README install snippets to point at the v0.7 package line.
- Future roadmap docs now consistently reflect `@sisal/mysql` as the fifth
  adapter package and MySQL/MariaDB as distinct capability targets in the
  six-column matrix.
- Updated the agent/contributor guidance in `AGENTS.md` and `CLAUDE.md` to match
  the current workspace packages, adapter matrix, validation tasks, integration
  suites, and schema snapshot version.

### Fixed

- **CTE-prefixed mutations now fail typed on MariaDB (CI-caught).** MariaDB
  parses a `WITH` prefix only on `SELECT` (verified on 11.8.8), while MySQL 8+
  accepts it on mutations — so `db.with(cte).update(…)`/`.delete(…)`/
  `.insert(…)` reached MariaDB as a raw syntax error. The core renderer now
  guards the `WITH` prefix on all three mutation builders with a
  variant-narrowed `dialectGuard` (`WITH … UPDATE`/`WITH … DELETE`/
  `WITH … INSERT`, unsupported on `{ dialect: "mysql", variant: "mariadb" }`);
  base MySQL renders unchanged and `WITH … SELECT` stays fine everywhere. The
  shared mutation-joins integration scenario branches on a new `mutationCte`
  target capability — MariaDB asserts the typed guard and runs the same mutation
  through a derived-table source — and the mysql-family showcase example does
  the same. Caught by the first CI run of the new MySQL/MariaDB integration
  jobs.

- **`@sisal/mysql` value round-trips (v0.7 B8, live-caught).** Three bugs the
  network-free unit tests could not see, fixed and re-pinned: (1) plain
  objects/arrays reached mysql2's text protocol un-serialized — an object became
  invalid SQL and an **array expanded into one param per element**, silently
  shifting every later placeholder; the executor now `JSON.stringify`s them (the
  `JSON`-column value shape). (2) `DATETIME`/`TIMESTAMP` columns decoded to
  client-local `Date`s, timezone-shifting server values; the pool now sets
  `dateStrings: true` so temporal columns read back as exact server text. (3)
  Instants (`Temporal.Instant`/`ZonedDateTime`) serialized with a trailing `Z`
  that MySQL rejects in a datetime literal; the core renderer now tags instant
  params and rewrites them to **naive UTC** under the `mysql` render dialect
  only (shared by MySQL and MariaDB) — the `postgres`, `sqlite`, and `generic`
  render paths are byte-for-byte unchanged.

- **`@sisal/mysql` `RETURNING` execution strategy (v0.7 B7)** — the new
  `insertReturning(db, table, values)` helper answers "give me back the rows I
  just inserted" with the best strategy the connected server supports, rows in
  input order under both: real `INSERT … RETURNING` where the facade's detected
  identity lights it (MariaDB ≥ 10.5 — the helper catches exactly the core
  guard's typed error, keeping the core the single source of truth for
  variant/version floors), otherwise a transactional fetch-by-key fallback — one
  `INSERT` + one `SELECT` when every row carries its full primary key, or **one
  `INSERT` per row capturing each statement's own `LAST_INSERT_ID`** for a
  single-column key. Deliberately no first-id-plus-offset arithmetic: MySQL
  8.4's live-confirmed default `innodb_autoinc_lock_mode = 2` does not guarantee
  a batch's generated ids are consecutive, so the shortcut can silently return
  the wrong rows. Corners the fallback cannot answer honestly fail with a typed
  `ORM_INVALID_QUERY` (no primary key, a partial composite key, a
  `Sql`-expression key value, or a server-generated non-`AUTO_INCREMENT` key
  like `DEFAULT (uuid())` — which the live probe shows returning real rows on
  MariaDB and refusing typed on MySQL). Plumbing: `insertId` now flows executor
  → driver → facade result (`MysqlQueryResult.insertId`, bigint normalized to a
  precision-safe string), and key matching stringifies both sides to survive the
  number/string/bigint id-shape differences between drivers and column types.
  Pinned by 8 network-free unit tests; verified live on MySQL 8.4.10 and MariaDB
  11.8.8 × both drivers.
- **`@sisal/mysql` migrate wiring (v0.7 B6)** — the new `@sisal/mysql/migrate`
  export completes the shared adapter shape (`driver` · `history` · `migrator` ·
  `ddl`): `createMysqlMigrator`, `createMysqlMigrationHistoryStore`,
  `createMysqlMigrationDriver`, and `createMysqlMigrateExecutor` (which reuses
  the ORM adapter's connection-source routing, so `driver: "mariadb"` and the
  mandated decode options apply to migrations for free). Concurrent migrators
  are excluded with **`GET_LOCK`/`RELEASE_LOCK` named locks** — the
  `pg_advisory_lock` analogue from the v0.6 C4 report — held on a pinned
  executor session because MySQL named locks are connection-scoped; lock ids
  pass through verbatim (validated ≤ 64 chars, the MySQL cap) and the BIGINT
  lock result is coerced from the string `"1"` the bigint-as-string driver
  options produce. The history ledger obeys the adapter's own B5 DDL rules
  (`varchar(255)` key — a `TEXT` key is invalid MySQL — and `datetime(6)`).
  **`useTransaction` defaults to `false`**, unlike pg: MySQL/MariaDB DDL
  implicitly commits, so wrapping schema migrations in a transaction is a false
  promise; opt in for DML-only migrations. Pinned by 7 network-free unit tests;
  verified live on MySQL 8.4.10 and MariaDB 11.8.8 **× both drivers** (migrate →
  idempotent re-run → rollback with B5-generated DDL, ledger `appliedAt` matched
  true UTC, and real two-connection lock contention).
- **`@sisal/mysql` DDL generator (v0.7 B5)** — the new `@sisal/mysql/ddl`
  export: `generateMysqlUpStatements` and its per-piece helpers
  (`generateMysqlCreateTable`/`Indexes`/`ForeignKeys`/`AddColumn`,
  `quoteMysqlIdent`), a mechanical sibling of the pg generator implemented to
  the probe-verified C4 spec (`docs/mysql-ddl-mapping.md`) and pinned by 12
  network-free unit tests; the **generated** output was applied live to MySQL
  8.4.10 and MariaDB 11.8.8 (kitchen-sink table, FK pair with the child sorting
  first, incremental `ADD COLUMN` — defaults fired, FK/CHECK enforced). The full
  C4 type table (`serial` → `AUTO_INCREMENT`, `timestamp` → `DATETIME(6)`,
  `timestamptz` → `TIMESTAMP(6)` with explicit `NULL` when nullable, `uuid` →
  `CHAR(36)`, `bytea` → `LONGBLOB`, `json`/`.array()` → `JSON`, length-less
  `varchar` → `VARCHAR(255)`); foreign keys emit **table-level only, after every
  `CREATE TABLE`** (MySQL silently ignores inline `REFERENCES`); expression
  defaults always paren-wrap and literal defaults paren-wrap on
  TEXT/BLOB/JSON-mapped columns (the portable form both engines accept); no
  `ENGINE`/`CHARSET` clause. Three **fail-closed generation-time validations**
  throw a typed `ORM_DIALECT_UNSUPPORTED` instead of shipping SQL that fails at
  apply time: an `AUTO_INCREMENT` column must lead a key (the InnoDB rule), at
  most one per table, never via `ADD COLUMN`; no `TEXT`/`BLOB`/`JSON` key
  columns (use `varchar(n)`); no partial or functional indexes.
- **`@sisal/mysql` drivers + executor hardening (v0.7 B4)** — verified live on
  MySQL 8.4.10 and MariaDB 11.8.8 **× both drivers** (four combinations), pinned
  by 6 new network-free unit tests. `connect()` now **auto-detects the server
  identity**: one `select version()` fills the B1 `dialectIdentity` via the new
  `parseMysqlServerVersion` (MariaDB self-identifies in the string) — against a
  MariaDB container, `INSERT … RETURNING` returns rows with zero configuration
  while MySQL keeps the typed guard; defaults are on for real sources, off for
  injected executors, `detectVersion: false` for a fully lazy (fail-closed)
  connect. `connect({ driver: "mariadb" })` opts into the MariaDB
  Connector/Node.js (the C6 performance candidate) through `adaptMariadbPool` +
  a **runtime-computed specifier**, keeping the LGPL connector a soft
  run-time-only dependency; the mysql2-compatible bigint-as-string options hold
  on it too. **Live-probe catch, fixed and pinned:** the MariaDB connector
  JSON-serializes a plain `Uint8Array` parameter (silent BLOB corruption) — the
  adapter now re-views binary params as Node `Buffer`s (no copy). Value
  normalization: BLOB reads re-viewed as plain `Uint8Array`s; **`TINYINT(1)`
  deliberately stays `0`/`1`** (the SQLite-family precedent — a display width
  doesn't guarantee boolean semantics); JSON on MariaDB stays text (`LONGTEXT`
  alias — the wire protocol can't distinguish it, so parse-on-read is
  documented, not guessed).
- **`@sisal/mysql` adapter scaffold (v0.7 B3)** — the fifth Sisal dialect
  package exists at `packages/mysql/` with the shared adapter shape (`orm/` =
  dialect · errors · pool · executor · driver), wired into the workspace,
  `check`/`test`/docs gates, and JSR publish dry-run (`@sisal/mysql@0.7.0`,
  exports `.` and `./orm`; `./migrate` + `./ddl` land with B5/B6).
  `connect({ url | pool | client | executor })` opens a `MysqlDatabase` facade
  under the `mysql` dialect with the injectable executor seam every adapter uses
  (8 network-free unit tests against a recording fake). The default driver is
  `mysql2/promise`, **imported lazily**, with the C6-mandated
  `supportBigNumbers` + `bigNumberStrings` always set; statements run through
  the **text protocol** (`query()`), sidestepping MySQL 8's binary-protocol
  `LIMIT ?` rejection by construction. `connect({ variant, version })` fills the
  B1 `dialectIdentity` (exported `MARIADB_VARIANT`) — smoke-tested against live
  MySQL 8.4.10 and MariaDB 11.8.8: builder round trip, the C2
  `ON DUPLICATE KEY UPDATE` upsert with `excluded()`, transaction rollback, and
  MariaDB `INSERT … RETURNING` returning real rows through the identity.
- **MySQL renderings for `filter()` and the portable date helpers (v0.7 B2)** —
  the last two `ORM_DIALECT_UNSUPPORTED` throws under the `"mysql"` dialect are
  lifted with real SQL, executed live on MySQL 8.4.10 and MariaDB 11.8.8 with
  semantic checks before pinning in
  [`packages/orm/mysql_dialect_test.ts`](packages/orm/mysql_dialect_test.ts).
  `filter(agg, cond)` now rebuilds the exported aggregates as
  `agg(CASE WHEN cond THEN operand END)` under `mysql` (neither engine has a
  `FILTER` clause): the aggregate helpers stamp rebuild metadata into a WeakMap
  so the frozen fragments and public surface stay untouched; `count(*)` counts a
  literal `1`, `countDistinct` keeps `DISTINCT`, and a hand-written `` sql`…` ``
  aggregate (no metadata) keeps the typed throw. The date helpers render
  `DATE_FORMAT` (`dateTrunc`; string result like the SQLite family), `NOW(6)`,
  nested `DATE_ADD(…, INTERVAL ? unit)` (`dateAdd`/`dateSub`, quantities bound),
  and `FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(src)/N)*N)` (`dateBin`).
  Postgres/SQLite renderings are byte-unchanged. Recorded for the B4 executor:
  mysql2's binary protocol rejects a bound `LIMIT ?` on MySQL 8.4 (works on
  MariaDB and via the text protocol on both).
- **Analytics-readiness report + IR sketch (v0.7 A1-A4)** —
  [`docs/analytics-readiness.md`](docs/analytics-readiness.md) and
  [`packages/orm/analytics_result_inference_test.ts`](packages/orm/analytics_result_inference_test.ts).
  The report records the future analytical IR (`source`/`joins`/`filters`/
  `dimensions`/`metrics`/`windows`/`derivedFields`/`order`/`limit`/
  `executionPreference`), the `/rising` rollup walkthrough, and a five-dialect
  portability classification across PostgreSQL, Neon, SQLite, libSQL, and future
  MySQL/MariaDB. A3 is decided as a documented seam only: a future minimal
  `over()`/window expression belongs in core SQL expressions, while the rich
  metric/dimension/window-domain API belongs in `@sisal/analytics`. The
  prototype test proves dimension/metric/derived-field maps can infer an exact
  readonly result row. No analytics package, public API/export, renderer, or
  feature-matrix row ships with this investigation.

- **`(engine, variant, version)` dialect identity (v0.7 B1)** — the v0.6
  dialect-key decision is now core code, landed before the v0.8 IR freeze and
  pinned by
  [`packages/orm/dialect_identity_test.ts`](packages/orm/dialect_identity_test.ts).
  New `@sisal/orm` exports: `DialectIdentity`
  (`{ dialect, variant?,
  version? }` — `SqlDialect` stays the render key;
  accepted everywhere a bare dialect was: `renderSql`, `renderToPlan`,
  `normalizeSqlInput`, all non-breaking), `dialectGuard` (now public)
  generalized to **declarative** variant-narrowable targets plus `unless`
  refinements (`{ variant?, minVersion? }`) so guard chunks stay serializable
  data, `DialectGuardTarget`/`DialectGuardException`, and
  `compareServerVersions` (dotted-numeric prefix, suffix-blind). **Fail
  closed:** an unknown server version never lifts a version-gated guard. The
  `Database` facade carries a `dialectIdentity`
  (`createDatabase({ dialect, variant, version })`, inherited by transaction
  facades), and `SisalSchemaSnapshot` gains optional additive
  `dialectVariant`/`dialectVersion` fields. **First consumer:** the `RETURNING`
  guard is split per statement kind with the probe-verified MariaDB floors
  (`INSERT` 10.5+, `DELETE` 10.0.5+, `UPDATE` 13.0+) — a `mariadb` identity
  renders `INSERT`/`DELETE … RETURNING` while plain `mysql` keeps the typed
  guard, dormant until the `@sisal/mysql` adapter (v0.7 B4) fills the identity
  from the server handshake.

## 0.6.0 - 2026-07-01

### Added

- **MySQL-readiness report + MySQL-vs-MariaDB split decision (v0.6 C5 —
  workstream C complete)** —
  [`docs/mysql-readiness.md`](docs/mysql-readiness.md) +
  [`perf/mysql_variant_probe.ts`](perf/mysql_variant_probe.ts)
  (`deno task perf:mysql:variant`, gated behind `MYSQL_URL`). The consolidated
  workstream deliverable, with two recorded decisions: **(1) one `@sisal/mysql`
  adapter** — MySQL ≥ 8.0.16 baseline, MariaDB ≥ 10.10 on the same adapter
  through a variant-aware capability descriptor, not a second package; **(2) the
  `(engine, variant, version)` dialect identity is adopted** — snapshot dialect
  gains a variant/version axis, `dialectGuard` generalizes to a version-aware
  capability predicate, implemented in v0.7 before the v0.8 IR freeze. The
  ~20-row divergence matrix was executed against MySQL 8.4.10 and MariaDB 11.8.8
  (C2/C3's research claims graduated to executed facts; new findings: `LATERAL`
  and JSON `->>` are MySQL-only, `CREATE SEQUENCE` and native `UUID` are
  MariaDB-only). **Two final wrong-SQL renders were found and guarded:**
  `fullJoin` (no `FULL OUTER JOIN` on either engine) and `filter()` (no `FILTER`
  clause on either engine — `CASE WHEN` fallback routed to v0.7) now throw typed
  `ORM_DIALECT_UNSUPPORTED` under `mysql`, pinned in
  [`packages/orm/mysql_dialect_test.ts`](packages/orm/mysql_dialect_test.ts);
  Postgres/SQLite rendering unchanged. Includes the draft fifth
  capability-matrix column and the core-vs-adapter v0.7 build list.
- **MySQL type/DDL mapping, probe-verified (v0.6 C4)** —
  [`docs/mysql-ddl-mapping.md`](docs/mysql-ddl-mapping.md) +
  [`perf/mysql_ddl_probe.ts`](perf/mysql_ddl_probe.ts)
  (`deno task perf:mysql:ddl`, gated behind `MYSQL_URL`). The complete design
  the v0.7 `generateMysqlUpStatements` implements, with every claim executed
  against live MySQL 8.4.10 **and** MariaDB 11.8.8: the full column-kind → MySQL
  type table (serial → `AUTO_INCREMENT` with generation-time placement
  validation, `boolean` → `BOOLEAN`/`TINYINT(1)`, `json`/`.array()` → `JSON`,
  `timestamp` → `DATETIME(6)`, `timestamptz` → `TIMESTAMP(6)` with the
  probe-confirmed 2038 cliff, `bytea` → `LONGBLOB`, `uuid` → `CHAR(36)`) and the
  DDL rules with a probe finding behind each: **table-level FKs only** (MySQL
  silently ignores inline `REFERENCES` — the pg generator's after-CREATE
  ordering transfers as-is), paren-wrapped expression defaults (the only
  TEXT/JSON-default form both engines accept), no `CREATE INDEX IF NOT EXISTS`,
  DESC/functional/partial index quirks, no `ENGINE`/`CHARSET` clause (the
  cross-engine collation-name trap), and `GET_LOCK` as the migrator's
  advisory-lock analogue. Version floor: MySQL ≥ 8.0.16 / MariaDB ≥ 10.10; the
  MariaDB divergence table (inline-FK honored, JSON-as-`LONGTEXT` decoding to
  text, extended `TIMESTAMP` range) feeds C5.
- **MySQL driver survey + benchmarks (v0.6 C6)** —
  [`perf/MYSQL_DRIVER_SURVEY.md`](perf/MYSQL_DRIVER_SURVEY.md) +
  [`perf/mysql_driver_survey.ts`](perf/mysql_driver_survey.ts)
  (`deno task perf:mysql`, gated behind `MYSQL_URL`). Benchmarked `npm:mysql2`,
  `npm:mariadb`, and `jsr:@db/mysql@3.0.0-rc.1` from Deno 2.9 against real MySQL
  8.4.10 and MariaDB 11.8.8 (sequential parameterized latency — the metric that
  exposed the `@db/postgres` Nagle stall — plus pooled throughput and a
  value-shape probe), with a Node 26 dual-runtime check. **Decision for the v0.7
  `@sisal/mysql` adapter: `mysql2` as the lazily-imported default** (MIT,
  Deno+Node, prepared statements, ~0.08 ms p50 / ~20k qps, no Nagle-class stall)
  **with `supportBigNumbers`+`bigNumberStrings` mandatory** — its default
  `BIGINT` decode is silently lossy past 2⁵³; the options make it a
  precision-safe string matching `@sisal/neon`'s convention. `mariadb` (fastest:
  ~0.05 ms p50 / ~24.5k qps, `BigInt`-correct, LGPL-2.1) is the opt-in via the
  injectable-executor seam; `@db/mysql` (rc-only, Deno-only) is a watch;
  `@planetscale/database` is the future serverless variant. All drivers are
  loaded through runtime-computed specifiers, so the workspace takes on no MySQL
  driver dependency.
- **Typed `RETURNING` guard + dialect-guard sweep for `"mysql"` (v0.6 C3).**
  Rendering `returning()` on any insert/update/delete under the (adapterless,
  v0.7-bound) `"mysql"` dialect now throws a typed `ORM_DIALECT_UNSUPPORTED`
  instead of emitting `RETURNING` SQL the engine rejects — MySQL 8/9 has no
  `RETURNING`, and MariaDB's is per-statement and per-version (`DELETE` 10.0.5+,
  `INSERT`/`REPLACE` 10.5+, `UPDATE` only 13.0+ single-table), so even MariaDB
  emission waits for the `(engine, version)` dialect key; a fetch-by-key
  fallback is a v0.7 adapter/executor concern. The same sweep corrected every
  dialect guard that was wrong for MySQL: `distinctOn`, the array operators,
  data-modifying CTEs, and `DELETE … USING` now list `mysql` as unsupported, and
  `UPDATE … FROM` gained a new guard (MySQL's multi-table `UPDATE`/`DELETE`
  shapes are v0.7 mapping work). Row locking correctly stays allowed. With this,
  **no known construct renders wrong SQL under `"mysql"`** — everything either
  renders correctly or throws. The guard error message dropped its hardcoded "it
  is PostgreSQL-only" suffix (wrong for `RETURNING`, which SQLite also
  supports). Pinned in
  [`packages/orm/mysql_dialect_test.ts`](packages/orm/mysql_dialect_test.ts);
  Postgres/SQLite rendering unchanged (all four integration suites re-run
  green).
- **Dialect-mapped MySQL upsert + typed `excluded()` helper (v0.6 C2).** The
  same `onConflictDoUpdate`/`onConflictDoNothing` builder calls now render
  `ON DUPLICATE KEY UPDATE` under the (adapterless, v0.7-bound) `"mysql"`
  dialect instead of invalid PostgreSQL syntax — no separate Drizzle-style
  `onDuplicateKeyUpdate` surface. Recorded semantics (pinned in
  [`packages/orm/mysql_dialect_test.ts`](packages/orm/mysql_dialect_test.ts)):
  the conflict target is validated but not rendered (ODKU fires on any
  unique-key violation); a conflict `where` throws a typed
  `ORM_DIALECT_UNSUPPORTED`; `onConflictDoNothing` renders a no-op
  self-assignment (`INSERT IGNORE` rejected — it swallows unrelated errors). The
  new `excluded(column)` operator is the portable proposed-row reference:
  `excluded."col"` on Postgres/SQLite, `values(col)` on MySQL (the one spelling
  MySQL 5.7→9.x and MariaDB share; the MySQL-only 8.0.19+ row alias is deferred
  to the `(engine, version)` dialect work) — and it resolves the physical column
  name, fixing the naming-strategy footgun where a raw
  `` sql`excluded.hotScore` `` silently misses the `hot_score` mapping.
  Postgres/SQLite upsert rendering is unchanged. The activity-vectors example,
  the ETL rollup render tests, and the shared integration scenarios (the
  `upsert` and `ETL rollup` scenario bodies in `integration/_shared/`) now use
  the helper, so it executes against all four real engines.
- **ETL rollup verified + pinned across all four adapters (v0.6 A1).** The v0.5
  pieces — `insert().select()`, `filter()` FILTER aggregates, `dateTrunc`,
  `groupBy`, `onConflictDoUpdate` — are proven to compose into the canonical
  `post_events → post_hourly_stats` upsert-from-select as **one builder
  statement**, and pinned three ways:
  [`packages/orm/etl_rollup_test.ts`](packages/orm/etl_rollup_test.ts) (exact
  rendered SQL + cross-clause parameter order, `postgres` and `sqlite`
  dialects); a new `<adapter>: ETL rollup` integration test in each feature
  suite (fold → idempotent re-run → late-event upsert; verified on PostgreSQL
  16/17/18, Neon via wsproxy, SQLite, and libSQL) with a matching all-✅ row in
  [`docs/feature-matrix.md`](docs/feature-matrix.md); and the activity-vectors
  example conversion (below). **Findings:** the only raw seam is `coalesce(...)`
  (via the `sql` tag; proposed-row references use the exported `excluded()`
  helper), and on the SQLite family a _bare_ upsert-from-select (no WHERE/GROUP
  BY before `ON CONFLICT`) is rejected by the engine's parser — any window WHERE
  or rollup GROUP BY disambiguates; pinned in the sqlite/libsql suites. See
  [v0.6.0 roadmap A1](docs/v0.6.0-roadmap.md).
- **Workstream A closeout (v0.6 A2-A6).** The ETL readiness investigation now
  records the correctness substrate the future `@sisal/etl` runner must consume:
  a coarse run lock keyed by `sisal:etl:<job>` (`pg_try_advisory_lock` /
  `pg_advisory_unlock` on PostgreSQL/Neon, `BEGIN IMMEDIATE` for supported
  SQLite/libSQL runs, future MySQL/MariaDB `GET_LOCK` / `RELEASE_LOCK`), an
  `@sisal/etl`-managed
  `sisal_etl_checkpoints(job, window_end, pruned_before, updated_at)` table, and
  atomic idempotent `run` / `replay` / `backfill` semantics (half-open windows,
  upsert/replace metrics keyed by the rollup grain, load + checkpoint advance in
  one transaction). The contract also carries the **replay-vs-retention
  invariant**: replaying a window whose raw source rows were already pruned
  would silently overwrite good rollups with zeros, so the per-job
  `pruned_before` replay horizon advances atomically with the prune (never
  lagging the delete) and `replay`/`backfill` refuse windows behind it with a
  typed error (explicit unsafe override, mirroring `.unsafeAllowAllRows()`);
  v0.9 tests both the refusal and the crash direction. A5 closes around the
  existing `postgres-family-activity-vectors` runnable PoC (`@sisal/pg` on
  `@db/postgres` or postgres.js, plus `@sisal/neon`); the SQLite/libSQL sibling
  remains a future contract because stored functions, `ARRAY[...]`, and `unnest`
  do not port cleanly. A6 closes by routing window functions, `ARRAY[...]`,
  `unnest`, and the SQLite-family `json_array` / `json_each` alternative to the
  advanced-SQL contracts and v0.7/v0.8. This is docs/design only: no ETL
  package, scheduler, runtime, public export, or feature-matrix lock/checkpoint
  claim was added; v0.9 owns the test-backed implementation before v0.10
  consumes it.
- **Latent `"mysql"` render path pinned (v0.6 C1)**
  ([`packages/orm/mysql_dialect_test.ts`](packages/orm/mysql_dialect_test.ts)).
  Render-ready today: backtick quoting, `?` placeholders, `ilike`→`LIKE`, plain
  `SELECT`/`INSERT`, `FOR UPDATE`, `onConflictDoUpdate` / `onConflictDoNothing`
  → `ON DUPLICATE KEY UPDATE`, and the new portable `excluded(column)` helper
  (`excluded."col"` on PostgreSQL/SQLite, `values(col)` on MySQL). Pinned
  caveats, drizzle-parity style: MySQL upsert targets are validation-only and
  conflict `where` throws `ORM_DIALECT_UNSUPPORTED` (C2 semantics work),
  `returning *` renders though MySQL 8 has no `RETURNING` (C3 gap), `distinctOn`
  renders unguarded (guard lists only `sqlite`), and `dateTrunc`/`now`/`dateBin`
  throw `ORM_DIALECT_UNSUPPORTED` (no `mysql` variants) — the last two are new
  findings beyond the roadmap's probe.

- **Cross-adapter decode-parity test**
  ([`integration/cross_adapter_parity_test.ts`](integration/cross_adapter_parity_test.ts)),
  gated behind `DATABASE_URL` (plus `NEON_DATABASE_URL`/`NEON_WS_PROXY` for the
  neon leg). Runs the same schema-free rich row through each PostgreSQL-family
  adapter and pins how they relate: the two `@sisal/pg` drivers (`@db/postgres`
  ↔ postgres.js) decode **byte-identically**, and `@sisal/neon` aligns with
  `@sisal/pg` on every type **except `bigint`** (neon → `string`, pg → `BigInt`;
  values equal), with the raw-`date` `Date` timezone-convention difference
  documented rather than failed. A driver behavior change fails the test and
  forces a doc update. See the [v0.6.0 roadmap](docs/v0.6.0-roadmap.md)
  "Cross-adapter parity" section.
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

- **Root README refreshed for the 0.6.0 release state.** Install snippets now
  pin `0.6.0`; adapter dependency notes mention the optional `@sisal/pg`
  postgres.js path; development checks include the feature-matrix gate; and the
  opt-in integration commands now include Neon, PostgreSQL migration apply, and
  cross-adapter decode parity.
- **v0.7 roadmap reconciled with the v0.6 closeout.** Added the consolidated
  priority-summary tracker (the v0.5/v0.6 pattern the doc lacked): four
  analytics-readiness tasks and ten `@sisal/mysql` build tasks with the P1 spine
  (`B1` dialect axis before the v0.8 IR freeze; `B2` `filter()`/date- helper
  renderings gating the integration suite). Stale Workstream B prose was updated
  to the v0.6 facts: the driver is chosen (C6), the upsert is implemented (C2),
  the guard sweep is complete (C3/C5), the DDL/type mapping is probe-verified
  (C4), and the split is decided (C5) — so v0.7's B-stream is build-to-spec; the
  incorrect "MySQL 8.0.21+ `RETURNING`" claim was corrected (MySQL has none),
  and the retired risks/open questions are marked answered.
- **`examples/postgres-family-activity-vectors`: the fold, both retention
  rollups, and the event prune are now typed builder statements** (v0.6 A1
  verification). `app.fold_events_to_buckets`, `app.rollup_daily`,
  `app.rollup_monthly`, and `app.prune_events` were removed from
  `migrations/0002_functions.sql` and rewritten as `insert().select()` +
  `FILTER` + `dateTrunc` + `onConflictDoUpdate` (and a bulk `delete()`) in
  `src/events.ts` / `src/retention.ts`; only the window-function stats, the
  `ARRAY[...]` projection, and `unnest` cosine similarity remain SQL functions
  (the v0.7 walls). The gated `feature_db_test.ts` now connects through the
  example's `openDb()`, so `SISAL_ADAPTER=pg | pg-postgres-js | neon` runs the
  whole chain on any PostgreSQL-family driver (verified on all three);
  `getSimilarPosts` normalizes `bigint` ids to strings at the query boundary
  (the documented cross-adapter `bigint` divergence surfaced as a real bug when
  the suite first ran on `@sisal/pg`).
- **Compatibility docs refreshed** — suite counts and last-run dates in
  `docs/{pg,neon,sqlite,libsql}-compatibility.md` (41/41 on pg16/17/18 and
  neon-proxy; 40/40 on sqlite and libsql, 2026-07-01).
- **Adapter feature integration suites now share scenario registries** under
  `integration/_shared/` + thin `integration/_targets/` entrypoints. The public
  `integration/{pg,neon,sqlite,libsql}_features_test.ts` files still register
  the same `<adapter>:` Deno test names, while
  `tools/generate_feature_matrix.ts --check` now validates feature-matrix cells
  against the registered scenarios instead of scraping test files.
- **Examples: consolidated the four rising-feed apps into two dialect-family
  examples** (pilot for a family-based example taxonomy). The three
  PostgreSQL-family feeds — `postgres-rising-feed`, `neon-rising-feed`, and
  `neon-rising-feed-ctes` — become one
  [`examples/postgres-family-feed`](examples/postgres-family-feed/) that runs
  over any PostgreSQL-family driver (`@sisal/pg` on `@db/postgres` or
  postgres.js, or `@sisal/neon`) selected by `SISAL_ADAPTER`, keeping both
  recompute strategies (DB functions in `src/recompute.ts` and builder-native
  chained CTEs in `src/recompute_ctes.ts`). `libsql-rising-feed` becomes
  [`examples/sqlite-family-feed`](examples/sqlite-family-feed/), which runs over
  `@sisal/libsql` or embedded `@sisal/sqlite`. This works because within a
  dialect family the builder + dialect are shared and the facades are
  structurally identical (`NeonDatabase` ≡ `PgDatabase`; `SqliteDatabase` ≡
  `LibsqlDatabase`), so only the connection differs — the app code is identical.
  A future `mysql-family` (MySQL/MariaDB) slots in the same way. Root
  `deno.json` workspace/`check` and `examples/README.md` updated accordingly.
- **Examples: extended the dialect-family taxonomy to the basics and
  showcases.** The three basics (`basic-postgres` + `basic-sqlite` +
  `basic-libsql`) become two —
  [`postgres-family-basic`](examples/postgres-family-basic/) (schema DDL +
  connect/CRUD over `@sisal/pg` on `@db/postgres`/postgres.js, or `@sisal/neon`)
  and [`sqlite-family-basic`](examples/sqlite-family-basic/) (over embedded
  `@sisal/sqlite` or `@sisal/libsql`), each driver-selected by `SISAL_ADAPTER`.
  `showcase-postgres`/`showcase-sqlite` become
  [`postgres-family-showcase`](examples/postgres-family-showcase/) and
  [`sqlite-family-showcase`](examples/sqlite-family-showcase/): the PostgreSQL
  tour now runs its live section over `pg` / `pg-postgres-js` / `neon`, and the
  SQLite tour over embedded `@sisal/sqlite` or `@sisal/libsql` — previously each
  only exercised one driver despite claiming the sibling worked. This also fixes
  a latent bug in the PostgreSQL showcase's rolled-back live run:
  `db.transaction` wraps a callback-thrown error in an `OrmError`, so the
  `Rollback` sentinel is now found by walking the cause chain (the live path was
  never runnable before).
- **Examples: the last two neon examples join the dialect-family taxonomy.**
  `neon-hot-feed` becomes
  [`postgres-family-hot-feed`](examples/postgres-family-hot-feed/) and
  `neon-activity-vectors` becomes
  [`postgres-family-activity-vectors`](examples/postgres-family-activity-vectors/),
  each now runnable over `@sisal/pg` (`@db/postgres` or postgres.js) or
  `@sisal/neon` via `SISAL_ADAPTER` (previously neon-only). The Neon serverless
  single-statement shape still holds under `SISAL_ADAPTER=neon`. The
  activity-vectors move also fixed a real `bigint` portability bug it surfaced:
  `getSimilarPosts` matched a source post by its `bigint` `post_id` with strict
  `===` against a string id, which quietly works on `@sisal/neon` (bigint →
  `string`) but throws `no stats for post` on `@sisal/pg` (bigint → `BigInt`) —
  now compared via `String(post_id)`. See the `bigint` cross-adapter caveat in
  the [v0.6.0 roadmap](docs/v0.6.0-roadmap.md). **Every `examples/` runnable is
  now dialect-family-organized** (postgres-family:
  basic/showcase/feed/hot-feed/activity-vectors; sqlite-family:
  basic/showcase/feed).
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

## 0.5.1 - 2026-06-30

> Shipped ahead of the planned v0.6.0; the analysis behind it is documented as a
> finding in [`docs/v0.6.0-roadmap.md`](docs/v0.6.0-roadmap.md). All workspace
> packages bump to 0.5.1 in lockstep; only `@sisal/pg` has code changes.

### Added

- **postgres.js driver for `@sisal/pg`** (`@sisal/pg` → 0.5.1). A
  postgres.js-backed pool — `createPostgresJsPool` (exported), also selectable
  with `connect({ url, driver: "postgres-js" })` — that avoids
  `jsr:@db/postgres`'s ~40 ms/query extended-protocol stall (no `TCP_NODELAY` +
  un-coalesced Parse/Bind/Describe/Execute/Sync writes → Nagle × delayed-ACK).
  It drops per-query latency ~100× — a real feed server went **120 → 6,774 rps,
  p50 90 ms → 1.6 ms** — with **no change to `@sisal/orm` or the executor**,
  which is driver-agnostic (`PgPool`/`PgClient`). Options: `prepare` (default
  `true`; set `false` for PgBouncer/Neon-pooled endpoints), `poolSize`,
  `idleTimeout`. Type parity with `@db/postgres` is preserved (int8 → `BigInt`;
  `date`/`timestamp` decode via `new Date(str)`), validated by the full
  `integration/pg_features_test.ts` matrix — **40/40 across PostgreSQL
  16/17/18** — run on the new driver through a `SISAL_PG_DRIVER=postgres-js`
  harness seam. `npm:postgres` is a new, lazily-imported dependency of
  `@sisal/pg` (consistent with `@sisal/libsql`'s `npm:@libsql/client`); the
  **default driver stays the pure-JSR `@db/postgres`**. New public surface:
  `createPostgresJsPool`, `PostgresJsPoolOptions`, `PgDriverKind`, and
  `driver`/`prepare`/`idleTimeout` on `PgConnectionOptions`. Full analysis:
  [`perf/PG_ADAPTER_PERF_REPORT.md`](perf/PG_ADAPTER_PERF_REPORT.md).
- **Real-Postgres latency benchmark suite** under [`perf/`](perf/README.md),
  gated behind `DATABASE_URL` like the `integration/` suites (kept out of the
  network-free `deno task test`). It isolates Sisal's per-query cost from the
  underlying driver by timing the same query six ways — Sisal render (no DB),
  Sisal `execute` over `@db/postgres`, raw `@db/postgres` parameterized, raw
  `@db/postgres` inlined (simple protocol), `postgres.js` as a fast reference,
  and **`sisal-pgjs`** (Sisal `execute` over a postgres.js pool — the validated
  fix) — and prints a p50/p90/p99 table plus a plain-language verdict. Adds
  `deno task perf:pg` (standalone probe) and `deno task perf:pg:guard`
  (`perf/pg_driver_latency_test.ts`, a guard that asserts the builder is ~free
  and Sisal's executor adds no measurable overhead over the raw driver call, and
  loudly characterizes — with `SISAL_PERF_STRICT=1` to hard-fail — the
  `jsr:@db/postgres` extended-protocol stall). `perf/latency.ts`,
  `perf/pg_driver_latency.ts`, and `perf/postgres_js_pool.ts` are added to
  `deno task check`.

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
