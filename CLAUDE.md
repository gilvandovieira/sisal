# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

Sisal is a Deno-first database toolkit published to JSR: a driverless ORM,
migration tooling, and adapter packages for PostgreSQL, Neon, SQLite,
libSQL/Turso, and MySQL/MariaDB. It is a Deno workspace with no build step. The
`@sisal/orm` + `@sisal/migrate` core is pure JSR; npm appears only at explicit
adapter/benchmark boundaries (`npm:@libsql/client`, MySQL driver packages, and
`npm:drizzle-orm` in benchmarks).

## Commands

```sh
deno task check        # type-check package entrypoints, examples, benches, perf probes
deno task test         # package unit tests only; network/FFI-free
deno task fmt          # format (lineWidth 80, semicolons)
deno task fmt:check    # read-only formatting check
deno lint              # lint workspace with the Sisal lint plugin
deno task docs:check   # doc-coverage gate (see below)
deno task docs:llms    # regenerate docs/llms.txt and docs/llms-full.txt
deno task docs:llms:check # verify generated docs/llms*.txt are current
deno task docs:matrix  # regenerate docs/feature-matrix.md
deno task docs:matrix:check # verify every ✅/⚠️ is scenario-backed
deno task bench        # benchmarks
deno task audit        # OSV advisory check
deno task hooks:install # install the pre-commit hook (deno fmt --check)
deno task sisal <cmd>  # migration CLI (init|generate|migrate|status|drift)
```

Run a single test file or filter by test name:

```sh
deno test --allow-read packages/orm/tests/mod_test.ts
deno test --allow-read packages/orm --filter "operators"
```

`deno task test` is intentionally **network- and FFI-free**. It runs package
tests under `packages/` plus `tools/lint`, and never touches a real database.
The real-database feature suites live in `integration/`, are **excluded** from
the test task, and each is gated behind an env var:

```sh
# PostgreSQL 16/17/18 - needs Docker
docker compose -f docker/compose.yaml up -d pg16 pg17 pg18
DATABASE_URL=postgres://postgres:postgres@localhost:55418/sisal \
  deno test --allow-net --allow-env --allow-read integration/pg_features_test.ts
scripts/pg-matrix.sh            # runs all three versions + prints the matrix

# ETL (@sisal/etl) — acceptance + failure/limits batteries, Postgres-gated
DATABASE_URL=postgres://postgres:postgres@localhost:55418/sisal \
  deno test --allow-net --allow-env --allow-read \
  integration/etl_features_test.ts integration/etl_limits_test.ts

# Neon local WebSocket proxy - Docker compose supplies the proxy and Postgres
docker compose -f docker/compose.yaml up -d neon-proxy
NEON_DATABASE_URL=postgres://postgres:postgres@localhost/sisal \
NEON_WS_PROXY=localhost:5499 \
  deno test --frozen -A integration/neon_features_test.ts

# SQLite (embedded) and libSQL/Turso (local file, or remote via TURSO_* env)
SISAL_SQLITE_IT=1 deno test -A integration/sqlite_features_test.ts
SISAL_LIBSQL_IT=1 deno test -A integration/libsql_features_test.ts

# MySQL/MariaDB - external servers or URLs required; docker/compose.yaml does
# not currently provide these services.
SISAL_MYSQL_IT=1 MYSQL_URL=mysql://... \
  deno test -A integration/mysql_features_test.ts
SISAL_MARIADB_IT=1 MARIADB_URL=mysql://... \
  deno test -A integration/mariadb_features_test.ts
```

`deno task docs:check` (`tools/check_docs.ts`) requires **100% module docs** and
**>=80% JSDoc** on every package's export modules. A new public export without a
`/** ... */` doc comment can fail it. `deno task docs:matrix:check` verifies
`docs/feature-matrix.md` is current and every ✅/⚠️ claim is backed by a named
integration scenario.

## Changelog Discipline

`CHANGELOG.md` is the canonical workspace changelog. Keep it current whenever a
change affects public APIs, package exports, adapter behavior, migration
behavior, CLI behavior, documentation, examples, benchmarks, CI, release
workflows, or package metadata.

Use an `Unreleased` section for ongoing work unless the change is part of a
specific version bump. When preparing a release, move relevant entries under the
release version and date. Do not leave user-visible or release-relevant changes
untracked in the changelog.

## Architecture

**Strict, one-directional package boundaries.** `@sisal/core` (`packages/core`,
extracted in v0.8) is the driverless base: schema primitives, the fragment SQL
IR, expression operators, the capability registry, and the dialect renderer.
`@sisal/orm` builds the fluent query builders, `Database` facade, relations, and
typed function caller on top of it and re-exports the whole core surface
(existing `@sisal/orm` imports keep working). `@sisal/migrate` depends on
**`@sisal/core` only**. The adapters (`@sisal/pg`, `@sisal/neon`,
`@sisal/sqlite`, `@sisal/libsql`, and `@sisal/mysql`) depend on the ORM and
migrate. **Core and the ORM never import an adapter or a database driver**.
Adapters do not import each other except for intentional, documented reuse
through an adapter boundary (Neon reuses PostgreSQL behavior through
`@sisal/neon`). Each package's `deno.json` exposes narrow subpath exports
(`./orm`, `./migrate`, `./ddl`; the migrate package also `./cli`, `./core`, and
`./workflow`; `@sisal/core` exposes `.`, `./schema`, and the non-public
`./unstable-internal` builder plumbing seam). See
[docs/core-migration.md](docs/core-migration.md) for the extraction's import
mapping.

**The serializable schema snapshot is the spine that connects everything.** The
flow is: `defineTable(...)` -> `createSchemaSnapshot(tables)` (normalize +
validate, `SisalSchemaSnapshot` version 2) -> `diffSchemaSnapshots(from, to)` ->
either migrate's `planSchemaChanges` (classifies + flags destructive changes) or
an adapter's pure DDL generator
(`generate{Postgres,Sqlite,Libsql,Mysql}UpStatements`, with Neon re-exporting
PostgreSQL DDL behavior). DDL generators emit **only additive SQL**; today that
means `CREATE TABLE` and `ADD COLUMN`. Destructive diffs (drop/alter) are
detected and returned in a separate `destructive` array, never emitted.
`packages/core/schema.ts` (`@sisal/core/schema`; `@sisal/orm/schema` re-exports
it) holds this snapshot contract and deliberately has no dependency on the rest
of the core. Current snapshot dialects are `generic`, `postgres`, `sqlite`, and
`mysql`; optional `dialectVariant`/`dialectVersion` fields carry engine identity
such as MariaDB vs MySQL.

**The heart is split across two packages since the v0.8 extraction.** The lower
tier lives in **`packages/core/`** (`@sisal/core`): `error`, `logger`, `schema`,
`errors`, `sql`, `capabilities`, `operators`, `columns`, `temporal`, and
`table`, re-exported through its `mod.ts`. `sql.ts` owns the `sql` tag,
identifier/parameter rendering, dialect-aware rendering, prepared-statement
plans, `Condition` wrappers, and the opaque `SqlChunk.meta` extension seam.
`capabilities.ts` owns the declarative `(engine, variant, version-range)`
capability registry that every dialect guard derives from. `table.ts` owns
`defineTable`, table constraints, type inference, introspection, and
`createSchemaSnapshot`. The upper tier stays in **`packages/orm/core/`**:
`builders`, `relations`, `functions`, and `database`, behind the barrel
`core/mod.ts` (which re-exports the full core surface plus the ORM tier —
`@sisal/orm/core` is the compatibility path). `builders.ts` owns immutable
Select/Insert/Update/Delete, compound queries, CTEs/subqueries, keyset
pagination, and prepared queries. `database.ts` owns the `Database` facade,
`OrmDriver` contract, transactions, batches, and built-in drivers. The ORM tier
reaches non-public core plumbing only through `@sisal/core/unstable-internal` —
never deep-import core module files. To avoid a runtime cycle, `sql.ts` detects
a query builder via the `QUERY_BUILDER_BRAND` symbol the builder classes stamp
on themselves, rather than importing the builders.

**Adapters share the same boundary shape where practical.** `<adapter>/orm/`
contains the dialect/executor/driver/pool-or-database/errors pieces that
implement the ORM's `OrmDriver`/`Database`; `<adapter>/migrate/` contains the
driver/history/migrator/DDL boundary; each adapter exposes a DDL export. Neon is
flatter internally but still exposes `./orm`, `./migrate`, and `./ddl`. Real
drivers (`jsr:@db/postgres`, `jsr:@neon/serverless`, `jsr:@db/sqlite`,
`npm:@libsql/client`, and MySQL/MariaDB driver packages) are imported
**lazily**, and the SQL executor is **injectable**. This is why unit tests stay
network/FFI-free: they inject fake executors. libSQL is a SQLite fork, so it
reuses SQLite SQL (`LIBSQL_DIALECT = "sqlite"`) and differs only in connection
shape (local `file:` / remote Turso URL + auth token / embedded replicas).
`@sisal/mysql` uses one adapter for MySQL and MariaDB with detected
`(engine, variant, version)` identity; the default driver is lazy
`mysql2/promise`, and `connect({ driver: "mariadb" })` opts into the MariaDB
connector. MySQL has no `RETURNING`, so `insertReturning` uses a fetch-by-key
fallback; MariaDB lights `INSERT`/`DELETE ... RETURNING` through detected
identity. MySQL JSON reads back parsed; MariaDB JSON reads back as text.

**The CLI** (`packages/migrate/src/cli.ts`) wraps the snapshot workflow as
`sisal` (`init`, `generate`, `migrate`, `status`, `drift`). The runner is fully
injectable (config/fs/adapters) for tests; the executable path lazily loads the
dialect adapter resolved from the config's `dialect`. `sisal init` targets are a
single `INIT_TARGETS` registry: adding a new database target is one registry
entry (id, aliases, dialect, connection hints).

**Drizzle parity and the feature matrix are the evolution discipline.**
`docs/drizzle-parity.md` is a living ✅/🟡/🔷/❌ matrix paired with
`packages/orm/tests/drizzle_parity/*_test.ts` and
`packages/{pg,sqlite}/tests/drizzle_parity_test.ts`. Some tests assert that
_unbuilt_ Drizzle features are still absent, so adding one fails a test that
points back at the doc. **Implement a feature, move its matrix row, and update
the parity test together.** Cross-adapter behavior is tracked in
`docs/feature-matrix.md`, generated from `tools/feature_matrix.ts`; every ✅/⚠️
must be backed by a named integration scenario and pass
`deno task docs:matrix:check`. Per-engine behavior is pinned by
`docs/{pg,neon,sqlite,libsql,mysql}-compatibility.md` and
`integration/<adapter>_features_test.ts`; the homepage `docs/index.html`
`#compat` section aggregates them.

## Conventions that bite if you don't know them

- **Columns are nullable by default** (matching SQL/Drizzle, the opposite of
  many ORMs). `.notNull()` opts out; `.primaryKey()` implies not-null.
  `.optional()` is an **insert-only** axis and does _not_ change column
  nullability. A plain nullable column is still required on insert unless
  `.optional()`/`.default()`.
- **Column names are `snake_case` by default** (since 0.4.0). The `defineTable`
  property key stays the JS-side name; the physical column name is derived by a
  naming strategy that defaults to `snake_case` (`hotScore` -> `hot_score`,
  idempotent on keys already in snake_case). The builder maps key <-> physical
  on both write and read (`SELECT *`/`RETURNING *` alias `phys AS key`), so code
  that stays inside the builder is transparent to it. Override per table with
  the `naming` option (`"snake_case"` | `"camelCase"` | `"preserve"` | a
  `(key) => name` fn), per column with `.named(...)` (always wins), or
  process-wide with `setDefaultColumnNaming(strategy)` (affects tables defined
  after the call). Use `naming: "preserve"` for the pre-0.4.0 verbatim behavior.
  Tests that assert literal SQL for camelCase-keyed tables must set
  `naming: "preserve"`.
- **Query builders are immutable**: every method returns a new builder.
- **Safety rail:** `update`/`delete` with no `where` throw unless you first call
  `.unsafeAllowAllRows()`.
- **SQL is rendered dialect-aware at render time** (`$1,$2` for postgres, `?`
  otherwise); operands render table-qualified and parameterized.
- **SQLite-family (sqlite + libsql) divergences:** no native `ILIKE`;
  `ilike`/`notIlike` render as ASCII case-insensitive `LIKE`/`NOT LIKE`;
  `json`/`jsonb` and arrays auto-serialize to TEXT and come back as strings
  (parse on read); booleans round-trip as `0`/`1`.
- **MySQL-family divergences:** no `FULL JOIN`, `DISTINCT ON`, native arrays,
  typed `db.call`, or data-modifying CTEs; `dateTrunc` returns text; booleans
  round-trip as `0`/`1`; MySQL JSON returns parsed values while MariaDB JSON
  returns text; partial/expression index support fails closed in the DDL
  generator where unsupported. Check `docs/feature-matrix.md` before promising a
  behavior across adapters.
- `deno fmt` is `lineWidth: 80`, semicolons on; the pre-commit hook blocks
  commits until `deno fmt --check` is clean.
