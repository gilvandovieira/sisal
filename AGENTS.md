# Repository Guidelines

## Project Shape

Sisal is a Deno-first database toolkit, published to JSR, split into workspace
packages (the `@sisal/orm` + `@sisal/migrate` core is pure JSR; npm appears only
at explicit adapter/benchmark boundaries — `npm:@libsql/client`, Neon's
transitive deps, and `npm:drizzle-orm` in benchmarks):

- `packages/orm`: driverless schema, typed SQL, query builders, snapshots,
  structured errors, and logger interfaces.
- `packages/migrate`: adapter-neutral migration definitions, checksums,
  planning, drift checks, workflow helpers, and generic execution.
- `packages/pg`: PostgreSQL ORM and migration adapter boundary plus DDL
  generation.
- `packages/sqlite`: SQLite ORM and migration adapter boundary plus DDL
  generation.
- `packages/libsql`: libSQL/Turso ORM and migration adapter boundary plus
  SQLite-compatible DDL aliases.

Keep dependency direction strict: `@sisal/orm` must stay driverless and must not
import PostgreSQL, SQLite, libSQL, Pequi Logger, or legacy package namespaces.
Adapters may depend on `@sisal/orm`; the ORM must not depend on adapters.

## Useful Commands

- `deno task fmt`: format the workspace.
- `deno task fmt:check`: check formatting only.
- `deno lint`: run linting, matching CI.
- `deno task check`: type-check all configured package, example, and benchmark
  entrypoints.
- `deno task test`: run package unit tests under `packages/`.
- `deno task docs:check`: verify documented API coverage.
- `deno task bench`: run benchmarks.

CI uses Deno `v2.9.0`, runs `deno install --frozen`, formatting, linting, docs
coverage, workspace type-checking, package-level tests, and
`deno publish --dry-run --allow-dirty` for each workspace package.

## Coding Conventions

- Use TypeScript with explicit exported types for public APIs.
- Preserve Deno formatting settings from `deno.json`: 80-column line width and
  semicolons.
- Public entrypoints are small `mod.ts` files with explicit export boundaries.
  Keep root exports focused on the package's documented surface.
- Put adapter-specific behavior under the relevant adapter package; keep shared
  dialect-neutral contracts in `packages/orm` or `packages/migrate`.
- Tests live next to package code as `*_test.ts`. Add or update focused tests
  when changing schema validation, DDL generation, migration planning, executor
  behavior, or public exports.

## Package Metadata

Each package has its own `deno.json` with `name`, `version`, `exports`, and
`publish` include/exclude rules. When adding new public files, update the
package exports and publish include list if the file should be shipped to JSR.

Examples live under `examples/basic-postgres`, `examples/basic-sqlite`, and
`examples/basic-libsql`. Docs live under `docs/`, with coverage checked by
`tools/check_docs.ts`.

## Changelog Discipline

`CHANGELOG.md` is the canonical workspace changelog. Keep it current whenever a
change affects public APIs, package exports, adapter behavior, migration
behavior, CLI behavior, documentation, examples, benchmarks, CI, release
workflows, or package metadata.

Use an `Unreleased` section for ongoing work unless the change is part of a
specific version bump. When preparing a release, move relevant entries under the
release version and date. Do not leave user-visible or release-relevant changes
untracked in the changelog.

## Local Git Notes

The pre-commit hook in `.githooks/pre-commit` checks formatting. Install it
with:

```sh
deno task hooks:install
```
