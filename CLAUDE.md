# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

Sisal is a Deno-first database toolkit published to JSR: a driverless ORM,
migration tooling, and small database adapters. It is a Deno workspace with no
build step. The `@sisal/orm` + `@sisal/migrate` core is pure JSR; npm appears
only at explicit adapter/benchmark boundaries (`npm:@libsql/client`, Neon's
transitive deps, `npm:drizzle-orm` in benchmarks).

## Commands

```sh
deno task check        # type-check every package entrypoint + examples + bench
deno task test         # unit tests — network/FFI-free, runs with only --allow-read
deno task fmt          # format (lineWidth 80, semicolons); fmt:check is read-only
deno task docs:check   # doc-coverage gate (see below)
deno task bench        # benchmarks
deno task hooks:install # install the pre-commit hook (runs `deno fmt --check`)
deno task sisal <cmd>  # run the migration CLI (init|generate|migrate|status|drift)
```

Run a single test file or filter by test name:

```sh
deno test --allow-read packages/orm/mod_test.ts
deno test --allow-read packages/orm --filter "operators"
```

`deno task test` is intentionally **network- and FFI-free** — it never touches a
real database. The real-database feature suites live in `integration/`, are
**excluded** from the test task, and each is gated behind an env var:

```sh
# PostgreSQL 16/17/18 — needs Docker
docker compose -f docker/compose.yaml up -d pg16 pg17 pg18
DATABASE_URL=postgres://postgres:postgres@localhost:55418/sisal \
  deno test --allow-net --allow-env --allow-read integration/pg_features_test.ts
scripts/pg-matrix.sh            # runs all three versions + prints the matrix

# SQLite (embedded) and libSQL/Turso (local file, or remote via TURSO_* env)
SISAL_SQLITE_IT=1 deno test -A integration/sqlite_features_test.ts
SISAL_LIBSQL_IT=1 deno test -A integration/libsql_features_test.ts
```

`deno task docs:check` (`tools/check_docs.ts`) requires **100% module docs** and
**≥80% JSDoc** on every package's export modules — a new public export without a
`/** … */` doc comment fails it.

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

**Strict, one-directional package boundaries.** `@sisal/orm` is the driverless
core. `@sisal/migrate` depends only on the ORM. The adapters (`@sisal/pg`,
`@sisal/sqlite`, `@sisal/libsql`) depend on the ORM and migrate. **The ORM never
imports an adapter or a database driver**; adapters never import each other.
Each package's `deno.json` exposes narrow subpath exports (`./orm`, `./migrate`,
`./ddl`, the migrate package also `./cli` and `./workflow`).

**The serializable schema snapshot is the spine that connects everything.** The
flow is: `defineTable(...)` → `createSchemaSnapshot(tables)` (normalize +
validate, `SisalSchemaSnapshot` version 1) → `diffSchemaSnapshots(from, to)` →
either migrate's `planSchemaChanges` (classifies + flags destructive changes) or
an adapter's pure DDL generator
(`generate{Postgres,Sqlite,Libsql}UpStatements`). DDL generators emit **only
additive SQL** (`CREATE TABLE`, `ADD COLUMN`); destructive diffs (drop/alter)
are detected and returned in a separate `destructive` array, never emitted.
`packages/orm/schema.ts` holds this snapshot contract and deliberately has no
dependency on the rest of the ORM core.

**`packages/orm/core/` is the heart**, split into coherent modules behind a
barrel `mod.ts` (which re-exports the public surface and keeps the `@module`
doc). The internal value-import graph is a strict DAG: `errors` ← `sql` ←
{`operators`, `columns`} ← `table` ← {`builders`, `relations`} ← `database`. The
files: `errors.ts` (`OrmError`); `sql.ts` (the `sql` tag, identifier/parameter
rendering, the dialect-aware renderer, prepared-statement plans, `Condition`
wrappers); `operators.ts` (`eq`/`and`/`inArray`/aggregates/`asc`/`desc`);
`columns.ts` (the `columns` factory + `ColumnBuilder`); `table.ts`
(`defineTable`, table constraints, type inference, introspection,
`createSchemaSnapshot`); `builders.ts` (immutable Select/Insert/Update/Delete +
compound + CTE/subquery + prepared queries); `relations.ts` (`relations()` + the
`db.query.<table>` runtime); `database.ts` (the `Database` facade, `OrmDriver`
contract, and built-in drivers). To avoid a runtime cycle, `sql.ts` detects a
query builder via the `QUERY_BUILDER_BRAND` symbol the builder classes stamp on
themselves, rather than importing `./builders.ts`. Add a public symbol to its
concern file **and** to the barrel's re-export list together.

**Every adapter has the same internal shape**, so they are interchangeable to
read: `<adapter>/orm/` = `{ dialect, executor, driver, pool|database, errors }`
implementing the ORM's `OrmDriver`/`Database`; `<adapter>/migrate/` =
`{ driver, history, migrator, ddl }`. The real driver (`jsr:@db/postgres`,
`jsr:@db/sqlite`, `npm:@libsql/client`) is imported **lazily**, and the SQL
executor is **injectable** — this is precisely why unit tests stay
network/FFI-free (they inject a fake executor). libSQL is a SQLite fork, so it
reuses SQLite SQL (`LIBSQL_DIALECT = "sqlite"`) and differs only in connection
(local `file:` / remote Turso URL + auth token / embedded replicas).

**The CLI** (`packages/migrate/cli.ts`) wraps the snapshot workflow as `sisal`
(init/generate/migrate/status/drift). The runner is fully injectable
(config/fs/adapters) for tests; the executable path lazily loads the dialect
adapter resolved from the config's `dialect`. `sisal init` targets are a single
`INIT_TARGETS` registry — **adding a new database target is one registry entry**
(id, aliases, dialect, connection hints).

**Drizzle parity is the evolution discipline.** `docs/drizzle-parity.md` is a
living ✅/🟡/🔷/❌ matrix paired with
`packages/{orm,pg,sqlite}/drizzle_parity_test.ts`. Some tests assert that
_unbuilt_ Drizzle features are still absent, so adding one fails a test that
points back at the doc. **Implement a feature, move its matrix row, and update
the parity test together.** Per-engine behavior is similarly pinned by
`docs/<db>-compatibility.md` ↔ `integration/<db>_features_test.ts`; the homepage
`docs/index.html` `#compat` section aggregates them.

## Conventions that bite if you don't know them

- **Columns are nullable by default** (matching SQL/Drizzle, the opposite of
  many ORMs). `.notNull()` opts out; `.primaryKey()` implies not-null.
  `.optional()` is an **insert-only** axis and does _not_ change column
  nullability — a plain nullable column is still required on insert unless
  `.optional()`/`.default()`.
- **Query builders are immutable** — every method returns a new builder.
- **Safety rail:** `update`/`delete` with no `where` throw unless you first call
  `.unsafeAllowAllRows()`.
- **SQL is rendered dialect-aware at render time** (`$1,$2` for postgres, `?`
  otherwise); operands render table-qualified and parameterized.
- **SQLite-family (sqlite + libsql) divergences:** no `ilike`; `json`/`jsonb`
  and arrays auto-serialize to TEXT and come back as strings (parse on read);
  booleans round-trip as `0`/`1`. PostgreSQL returns these parsed/typed.
- `deno fmt` is `lineWidth: 80`, semicolons on; the pre-commit hook blocks
  commits until `deno fmt --check` is clean.
