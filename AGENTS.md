# Repository Guidelines

## Project Shape

Sisal is a Deno-first database toolkit, published to JSR, split into workspace
packages. The `@sisal/orm` + `@sisal/migrate` core stays pure JSR; npm appears
only at explicit adapter, runtime, or benchmark boundaries such as
`npm:@libsql/client`, MySQL driver packages, and `npm:drizzle-orm` in
benchmarks.

- `packages/core`: the driverless compile target — schema primitives and
  snapshots, the fragment SQL IR, expression operators, the dialect capability
  registry, structured errors, and logger interfaces (extracted in v0.8).
- `packages/orm`: the fluent query builders, `Database` facade, relations, and
  typed function caller on top of `@sisal/core`, which it re-exports.
- `packages/migrate`: adapter-neutral migration definitions, checksums,
  planning, drift checks, workflow helpers, generic execution, and the CLI.
- `packages/pg`: PostgreSQL ORM and migration adapter boundary plus DDL
  generation.
- `packages/neon`: Neon serverless PostgreSQL adapter, reusing PostgreSQL SQL,
  DDL, and migration behavior through its own package boundary.
- `packages/sqlite`: SQLite ORM and migration adapter boundary plus DDL
  generation.
- `packages/libsql`: libSQL/Turso ORM and migration adapter boundary plus
  SQLite-compatible DDL aliases.
- `packages/mysql`: MySQL/MariaDB ORM and migration adapter boundary plus DDL
  generation.

Keep dependency direction strict. `@sisal/core` and `@sisal/orm` must stay
driverless and must not import adapters, database drivers, runtime-specific
adapter code, Pequi Logger, or application logging libraries. `@sisal/orm`
depends on `@sisal/core` (non-public plumbing only via
`@sisal/core/unstable-internal`). `@sisal/migrate` stays adapter-neutral and
depends on `@sisal/core` only. Adapters may depend on `@sisal/orm` and
`@sisal/migrate`; adapters must not import each other except for intentional,
documented reuse through adapter package boundaries.

## Useful Commands

- `deno task fmt`: format the workspace.
- `deno task fmt:check`: check formatting only.
- `deno lint`: run linting, matching CI.
- `deno task check`: type-check configured packages, examples, benchmarks, and
  perf probes.
- `deno task test`: run package-level, network/FFI-free unit tests.
- `deno task docs:check`: verify documented API coverage.
- `deno task docs:llms`: regenerate `docs/llms.txt` and `docs/llms-full.txt`.
- `deno task docs:llms:check`: verify generated LLM docs are current.
- `deno task docs:matrix`: regenerate `docs/feature-matrix.md`.
- `deno task docs:matrix:check`: verify the feature matrix is current and
  scenario-backed.
- `deno task bench`: run benchmarks.
- `deno task audit`: check advisories through OSV.
- `deno task sisal <cmd>`: run the migration CLI (`init`, `generate`, `migrate`,
  `status`, or `drift`).

Real-database suites live under `integration/` and are opt-in through env vars
such as `SISAL_SQLITE_IT=1`, `SISAL_LIBSQL_IT=1`, `SISAL_MYSQL_IT=1`, and
`SISAL_MARIADB_IT=1`.

CI uses Deno `v2.9.0`. The quality job runs `deno install --frozen`,
`deno fmt --check`, `deno lint`, `deno task --frozen docs:check`,
`deno task --frozen docs:llms:check`, `deno task --frozen docs:matrix:check`,
`deno task --frozen check`, and `deno publish --dry-run`. The package matrix
runs `deno check`, `deno test --frozen --allow-read`, and
`deno publish --dry-run --allow-dirty --config <package>/deno.json` for each
workspace package.

## Coding Conventions

- Use TypeScript with explicit exported types for public APIs.
- Preserve Deno formatting settings from `deno.json`: 80-column line width and
  semicolons.
- Public entrypoints are small `mod.ts` files with explicit export boundaries.
  Keep root exports focused on the package's documented surface.
- Public exports must have enough module docs and JSDoc to pass
  `deno task docs:check`.
- Add public symbols to their concern file and the relevant barrel export
  together.
- Put adapter-specific behavior under the relevant adapter package; keep shared
  dialect-neutral contracts in `packages/orm` or `packages/migrate`.
- Feature-matrix claims marked ✅/⚠️ must be backed by named integration
  scenarios.
- Package source lives under `packages/<name>/src/`, with public subpackages
  mirrored as `src/<subpackage>/` (for example `src/orm`, `src/migrate`, or
  `src/core`). Package root `mod.ts` files, README files, and `deno.json` stay
  at the package root.
- Package tests live under `packages/<name>/tests/`, mirroring subpackages when
  needed (for example `tests/orm` and `tests/migrate`). Add or update focused
  tests when changing schema validation, DDL generation, migration planning,
  executor behavior, feature-matrix claims, or public exports.

## Package Metadata

Each package has its own `deno.json` with `name`, `version`, `exports`, and
`publish` include/exclude rules. When adding new public files, update the
package exports and publish include list if the file should be shipped to JSR.

Examples live under:

- `examples/postgres-family-basic`
- `examples/sqlite-family-basic`
- `examples/postgres-family-showcase`
- `examples/sqlite-family-showcase`
- `examples/postgres-family-hot-feed`
- `examples/postgres-family-feed`
- `examples/sqlite-family-feed`
- `examples/postgres-family-activity-vectors`
- `examples/advanced-sql-contracts`

Docs live under `docs/`. `docs/feature-matrix.md` is generated by
`tools/generate_feature_matrix.ts`; `docs/llms.txt` and `docs/llms-full.txt` are
generated by `tools/generate_llms.ts`.

## Changelog Discipline

`CHANGELOG.md` is the canonical workspace changelog. Keep it current whenever a
change affects public APIs, package exports, adapter behavior, migration
behavior, CLI behavior, documentation, examples, benchmarks, CI, release
workflows, or package metadata.

Use an `Unreleased` section for ongoing work unless the change is part of a
specific version bump. When preparing a release, move relevant entries under the
release version and date. Do not leave user-visible or release-relevant changes
untracked in the changelog.

Changes to agent or contributor guidance should receive a concise `Unreleased`
documentation entry when they materially update repo workflow, package shape, or
validation rules.

## Local Git Notes

The pre-commit hook in `.githooks/pre-commit` checks formatting. Install it
with:

```sh
deno task hooks:install
```
