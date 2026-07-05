---
title: npm Distribution Plan
---

# Sisal on npm — execution plan

This is the **actionable execution plan** for publishing Sisal to **npm** under
the `@sisaljs` scope, running on **Node.js 24+**, alongside the existing JSR
distribution. It is the "how / tasks" companion to
[npm-release-readiness.md](npm-release-readiness.md) (the "why / feasibility").

**Deno/JSR stays the source of truth.** Everything here is additive: the Deno
workflow, `deno.json` files, and `@sisal/*` JSR names are unchanged. npm
artifacts are _generated_ from the Deno sources by a build step and published in
lockstep at identical versions.

---

## Locked decisions

| Decision                               | Value                                                                              | Rationale                                                                                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm scope                              | **`@sisaljs`**                                                                     | Org created and owned; scope ownership reserves every `@sisaljs/*` name automatically — no squatting possible, no stub reservation needed.                |
| Package shape                          | **10 packages, mirroring JSR**                                                     | Lets each adapter declare only its own driver as an optional peer dep; a Postgres user never installs `mysql2`.                                           |
| Build tool                             | **[`dnt`](https://github.com/denoland/dnt)** (Deno-to-Node Transform), per package | Rewrites `.ts` specifiers + `jsr:`/`npm:` schemes, resolves JSR deps, remaps scope, emits ESM/CJS + `.d.ts`, and type-checks + runs the suite under Node. |
| Node baseline                          | **Node 24+**                                                                       | `node:sqlite` (`DatabaseSync`) is stable, native ESM, `import.meta`, `node:test`.                                                                         |
| Module type                            | **ESM primary**, CJS emitted by dnt                                                | Matches Deno; CJS kept for reach. Revisit dropping CJS if it costs maintenance.                                                                           |
| Source of truth for versions & exports | **`deno.json`**                                                                    | `package.json` is generated; a freshness gate prevents drift.                                                                                             |
| Auth / release                         | **OIDC Trusted Publishing + `--provenance`**                                       | No long-lived `NPM_TOKEN`; signed provenance badge.                                                                                                       |
| Publish trigger                        | **Same version gate as `deno publish`**                                            | JSR and npm never diverge.                                                                                                                                |

### JSR → npm name map

| JSR                | npm                  |
| ------------------ | -------------------- |
| `@sisal/core`      | `@sisaljs/core`      |
| `@sisal/orm`       | `@sisaljs/orm`       |
| `@sisal/migrate`   | `@sisaljs/migrate`   |
| `@sisal/pg`        | `@sisaljs/pg`        |
| `@sisal/neon`      | `@sisaljs/neon`      |
| `@sisal/sqlite`    | `@sisaljs/sqlite`    |
| `@sisal/libsql`    | `@sisaljs/libsql`    |
| `@sisal/mysql`     | `@sisaljs/mysql`     |
| `@sisal/etl`       | `@sisaljs/etl`       |
| `@sisal/analytics` | `@sisaljs/analytics` |

### Driver map (JSR/Deno → Node peer)

| Adapter  | Deno driver (today)                                                | Node driver                                                     | Peer dep on npm                       | Notes                                                  |
| -------- | ------------------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------ |
| `pg`     | `jsr:@db/postgres` (**static**) + `npm:postgres` (dynamic default) | `postgres` (postgres.js) default; `pg` (node-postgres) optional | `postgres` optional, `pg` optional    | Static import in `pool.ts` must become lazy.           |
| `neon`   | `jsr:@neon/serverless` (dynamic)                                   | `@neondatabase/serverless`                                      | `@neondatabase/serverless` optional   | Dynamic already.                                       |
| `sqlite` | `jsr:@db/sqlite` (Deno FFI, dynamic)                               | **built-in `node:sqlite`** (`DatabaseSync`)                     | _none_                                | Only site needing a runtime branch, not just a rename. |
| `libsql` | `npm:@libsql/client` (dynamic)                                     | `@libsql/client`                                                | `@libsql/client` optional             | Already npm; scheme rewrite only.                      |
| `mysql`  | `npm:mysql2/promise` + `npm:mariadb` (dynamic)                     | `mysql2`, `mariadb`                                             | `mysql2` optional, `mariadb` optional | Already npm; scheme rewrite only.                      |

---

## Verified baseline (current state as of v0.11.1)

Confirmed against the code so the plan targets reality:

- ✅ **Zero bare `Deno.*` in shipped library source.** Only the CLI touches it,
  and it already reads via `globalThis.Deno` defensively
  (`packages/migrate/src/cli.ts:1283-1304`).
- ✅ **Drivers are injectable + lazy** everywhere **except** `@sisal/pg`, which
  imports `jsr:@db/postgres` **statically** (`packages/pg/src/orm/pool.ts:2`,
  `packages/pg/src/migrate/pool.ts:2`).
- ✅ Only one `node:` builtin in src (`node:buffer` in `mariadb_pool.ts:1`) —
  already Node-native.
- ⚠️ **~438 relative imports carry explicit `.ts` extensions** (Deno-mandatory,
  Node ESM rejects) → a build is required.
- ⚠️ **Driver import sites using `jsr:`/`npm:` schemes** (Node rejects the URL
  scheme):
  - `packages/pg/src/orm/pool.ts:2` (static),
    `packages/pg/src/migrate/pool.ts:2` (static)
  - `packages/pg/src/orm/postgres_js_pool.ts:70`
  - `packages/neon/src/client.ts:109,126`
  - `packages/sqlite/src/orm/database.ts:45`,
    `packages/sqlite/src/migrate/database.ts:44`
  - `packages/libsql/src/client.ts:156`
  - `packages/mysql/src/orm/pool.ts:148`,
    `packages/mysql/src/orm/mariadb_pool.ts:112`
- ⚠️ **Tests:** 565 `Deno.test` calls; runtime `@std` dep is `@std/log` (4 src
  sites); `@std/assert` + `@std/testing/snapshot` are test-only.

---

## Phases & tasks

Tasks are ID'd `NPM-n`. Each has an acceptance check. Phases are ordered by
dependency; within a phase, tasks can often run in parallel.

### Phase 0 — Foundation & decisions (record, don't build)

- [x] **NPM-1 — Record the decision.** ✅ Done —
      [npm-release-readiness.md](npm-release-readiness.md) now names `@sisaljs`
      (status banner, decision section, keep-open constraints, definition of
      done) and links this plan.
- [x] **NPM-2 — CHANGELOG `Unreleased` entry.** ✅ Done — added an `Unreleased`
      section recording the npm-distribution track start (docs/planning only, no
      package published).
- [x] **NPM-3 — Confirm the org & Node baseline.** ✅ Done — logged in as
      `gilvandolucasvieira`, **owner** of the `sisaljs` org (full publish
      rights), scope is empty, local env is Node v26.4.0 / npm 11.17.0. Pin CI
      to Node 24+.

### Phase 1 — Make the source runtime-portable (no build yet)

These are small code changes that keep Deno working _and_ unblock Node. Do them
first so the build in Phase 2 has nothing Deno-specific to trip on.

- [x] **NPM-4 — Make `@sisal/pg` driver imports lazy.** ✅ Done — both static
      `jsr:@db/postgres` imports in `pg/orm/pool.ts` and `pg/migrate/pool.ts`
      are now lazy facades (deferred `import("@db/postgres")` on first connect,
      bare import-map specifier). No top-level driver import remains; pg suite
      green (27 tests). `driver_default_test.ts` updated to assert the new
      invariant: **neither** driver eagerly constructs the JSR `Pool`.
- [x] **NPM-5 — Runtime-aware driver selection.** ✅ Done — sqlite branches
      through `packages/sqlite/src/native.ts` (the one adapter needing a genuine
      Deno-vs-Node driver fork); pg/mysql/libsql already lazy-import npm-capable
      drivers (specifier rewrite is Phase 2 dnt config, no runtime code). Added
      `assertDbPostgresRuntime()` guards so the Deno-only `db-postgres` driver
      fails legibly on non-Deno runtimes instead of an opaque module error.
      Injected pools/clients/databases still bypass all of it. Deno suites
      unchanged.
- [x] **NPM-6 — SQLite Node path via `node:sqlite`.** ✅ Done — `native.ts`
      opens `node:sqlite` `DatabaseSync` and adapts it to the executor's
      database surface (`run()` normalized to a numeric change count). Selection
      keys on **Deno FFI availability** (`hasDenoFfi()` → `Deno.dlopen`), which
      sidesteps dnt's FFI-less Deno test-shim. Compiles under both runtimes
      (docs/check green); `native_test.ts` pins the detection contract. **Node
      behavioral parity** (`readOnly` on `:memory:`, `int64`→`BigInt` vs
      `number`) is verified in Phase 2 under real Node — documented inline in
      `native.ts`.
- [x] **NPM-7 — Audit `globalThis.Deno` access.** ✅ Done — a grep for bare
      `Deno.` in `packages/*/src` returns **zero** sites; all runtime probes go
      through `globalThis`-guarded helpers (`hasDenoFfi`,
      `assertDbPostgresRuntime`, the CLI's existing accessors).

### Phase 2 — Build pipeline (dnt), core-first

- [x] **NPM-8 — `tools/build_npm.ts` skeleton.** ✅ Done — descriptor-driven dnt
      build; entry points + version read from each `deno.json`. Sibling
      `@sisal/*` imports map to `@sisaljs/*` deps (keyed by resolved export file
      + `subPath`, scanned from real imports so no unused mapping); driver
      specifiers map to optional peers. `deno run -A tools/build_npm.ts core`
      produces `npm/core/`.
- [x] **NPM-9 — Prove `@sisaljs/core` under Node.** ✅ Done — `npm/core` loads
      as **ESM and CJS** under Node 26, all three subpaths resolve, and real
      logic runs (schema snapshot v2, `hotScore`→`hot_score` snake_case).
      _Deviation:_ dnt's Node **type-check is opt-in**
      (`BUILD_NPM_TYPECHECK=1`), not on-by-default — stock TypeScript lacks
      `Temporal` types (Deno's lib has them; `deno task check` is the
      authoritative type gate). Node **runtime** is fine: Temporal is a native
      global on Node 24+. Provisioning Temporal types for the Node tsc + Node
      consumers is tracked as a follow-up.
- [x] **NPM-10 — Dependency-free tier.** ✅ Done — `orm` + `migrate` build
      ESM-only; cross-package resolution verified under Node (orm→core,
      migrate→core) running a real schema diff → migration plan. Requires
      `npm install --install-links` (Node resolves `file:` symlinks to their
      real path otherwise).
- [x] **NPM-11 — Adapters build + sqlite proven on Node.** ✅ Done — all 10
      `npm/<pkg>/` build. Driver specifiers rewrite correctly
      (`npm:postgres`→`postgres`, `npm:mysql2/promise`→`mysql2/promise`,
      `npm:@libsql/client`→`@libsql/client`) as optional peers. Deno-only
      drivers (`@db/postgres`, `@db/sqlite`) use **computed specifiers** (opaque
      to dnt, guarded at runtime); neon + mariadb use **runtime-aware computed
      specifiers** (Deno JSR vs Node npm) with npm peers declared via
      `extraPeers`. **`@sisaljs/sqlite` runs a full CRUD flow on Node via
      built-in `node:sqlite`** — surfaced + fixed a real boolean-binding parity
      gap (`node:sqlite` rejects JS booleans; now coerced to 0/1). ESM-only (the
      migrate CLI's top-level await precludes CJS). _Node type-check per NPM-9._
- [x] **NPM-12 — `build:npm` task + `.gitignore`.** ✅ Done —
      `deno task build:npm <ids>` / `deno task build:npm:all`; `/npm/`
      gitignored. One command builds all 10 deps-first.

#### Phase 2 verification — Node e2e battery (ahead of NPM-25)

A repeatable Node e2e battery (`tools/npm_e2e/run.sh` + `adapter_e2e.mjs`)
builds all packages, links them into a consumer with the real npm drivers, and
runs DDL + CRUD + aggregate + transaction-rollback through each adapter against
a real database. **All six adapters pass on Node 26** from the built npm
artifacts:

| Adapter | Node driver                          | Node e2e | Deno integration |
| ------- | ------------------------------------ | :------: | :--------------: |
| sqlite  | built-in `node:sqlite`               |    ✅    |      ✅ 48       |
| libsql  | `@libsql/client`                     |    ✅    |      ✅ 48       |
| pg      | `postgres` (postgres.js)             |    ✅    |      ✅ 50       |
| neon    | `@neondatabase/serverless` (wsproxy) |    ✅    |      ✅ 50       |
| mysql   | `mysql2`                             |    ✅    |      ✅ 50       |
| mariadb | `mariadb`                            |    ✅    |      ✅ 50       |

Databases come from `docker/compose.yaml`, which now also provides **`mysql`
(`:33306`) and `mariadb` (`:33307`)** so the whole matrix starts with one
`docker compose up`. The battery surfaced and fixed two real bugs: the
`node:sqlite` boolean-binding gap (NPM-11) and a latent integration-test
assertion mismatch (a guard-message needle `"functional indexes"` that never
matched the shipped `"functional (expression) indexes"` — the mysql/mariadb
suites are Docker-gated and rarely run, so it had gone unnoticed; both suites
are now 50/50).

### Phase 3 — Manifest generation & drift gate

- [x] **NPM-13 — Generate `package.json` from `deno.json`.** ✅ Done — the
      manifest surface (name via map, `version`, `type: module`,
      `engines.node >=24`, `exports` mirroring every subpath, sibling
      `@sisaljs/*` `dependencies`, optional `peerDependencies` +
      `peerDependenciesMeta` for drivers) now derives from **one** source of
      truth: `tools/npm_manifest.ts` (`buildManifest`) holds the descriptor
      table + derivation logic, and `tools/build_npm.ts` imports it, so dnt's
      emitted `package.json` and the committed snapshot can't diverge.
      _Verified:_ `npm/core/package.json` exports `.`, `./schema`,
      `./unstable-internal`; `npm/orm/package.json` exports its 5 subpaths and
      depends on `@sisaljs/core@^0.12.0` — matching `deno.json` and the snapshot
      exactly.
- [x] **NPM-14 — Freshness check `npm:check`.** ✅ Done —
      `tools/generate_npm_manifests.ts` (patterned on `docs:matrix:check`)
      writes the frozen intent of all 10 manifests to `docs/npm-manifests.json`;
      `deno task npm:manifests` regenerates it and `deno task npm:check`
      re-derives + diffs, failing on any drift in versions, exports, or the
      dependency/peer graph — **without** running a full dnt build.
      `buildManifest` additionally throws if a package imports an `@sisal/*`
      sibling it doesn't declare as a dep (self-imports excluded). _Verified:_
      adding a `./drift-probe` export to `packages/core/deno.json` fails
      `deno task npm:check` (exit 1); reverting it passes.

### Phase 4 — Dual-runtime tests

> **Design change (better than planned): no codemod.** The plan assumed a
> hand-rolled `harness.ts` + a 551-site `Deno.test` → `test()` codemod. Once
> Phase 2 proved dnt's toolchain, that turned out to be unnecessary **and**
> inferior: Node can't run the `.ts` tests as-is regardless (`.ts` specifiers,
> `jsr:@std` imports), so a transform is required either way — and dnt's
> transform already supplies `Deno.test`, `@std/assert`, and the `Deno.*` fs API
> via its dev **Deno shim**. So the idiomatic tests run on Node **unchanged**; a
> small build tool replaces dnt's (CJS, ESM-incompatible) test runner instead of
> rewriting 551 call sites. Lower risk, zero churn, tests stay Deno-idiomatic.

- [x] **NPM-15 — Node test runner (`tools/test_npm.ts`).** ✅ Done — runs a
      package's network-free unit suite under Node from the Deno sources: dnt
      transforms each `*_test.ts` (scoped per package via `rootTestDir`, so the
      Docker-gated `integration/` suites are excluded) with siblings **inlined**
      (no `@sisaljs/*` mapping) so cross-package tests resolve without the
      packages being published. The throwaway test scaffold omits
      `"type": "module"` at its root so Node runs dnt's CommonJS
      `test_runner.js` as CJS while the transformed tests under `esm/` stay ESM.
      _Accept:_ `core` runs green under Deno **and** Node
      (`deno run -A tools/test_npm.ts core`).
- [x] **NPM-16 — Full unit suite green on Node (`deno task test:node`).** ✅
      Done — all **10** packages pass under Node 26 from the transformed sources
      (`deno run -A tools/test_npm.ts all`); the Deno suite stays green
      (`deno task test`, 608). Four tests were made **dual-runtime** rather than
      forked: `sqlite/native_test` (FFI detection now tracks the host runtime),
      `orm/golden_sql_test` (the `@std/testing/snapshot` goldens run under Deno
      and skip under Node — the same renders are pinned by non-snapshot
      goldens), and the `etl`/`analytics` `boundary_test`s (static source-tree
      scans that run under Deno; the boundary is also enforced by the
      `tools/lint` plugin). Detection keys on `Deno.dlopen` (FFI) because dnt's
      Node shim fakes `Deno.version` but not FFI. `tools/lint` tests stay
      Deno-only (they use the Deno lint-plugin API, which has no Node
      equivalent). **Fixed a real, publish-affecting bug:**
      `packages/migrate/src/cli.ts` carried a Deno shebang
      (`#!/usr/bin/env -S deno run …`) that dnt emitted mid-file (after the
      injected shims), where Node parsed it as a broken regex; removed it (Deno
      invokes the CLI via `deno task sisal`, and the Node `bin` gets its own
      `#!/usr/bin/env node` at NPM-18).

### Phase 5 — CLI & examples

- [x] **NPM-17 — Node filesystem impl for the CLI.** ✅ Done —
      `nodeMigrationFileSystem()` (`node:fs/promises`, lazily imported) sits
      beside `denoMigrationFileSystem()`; `defaultMigrationFileSystem()` selects
      by runtime and the CLI uses it. `getEnv` gained a `process.env` fallback
      (guarded so a Deno run without `--allow-env` still reports vars as unset),
      and `sisal init` now scaffolds a **runtime-aware** config — npm scope +
      `process.env` on Node, JSR scope + `Deno.env.get` on Deno. _Verified:_
      `sisal init/generate/migrate/status/drift` run under Node; the CLI suite
      is green under both runtimes (`tools/test_npm.ts migrate`).
- [x] **NPM-18 — `bin/sisal` entry.** ✅ Done — the migrate descriptor carries
      `bin: { sisal: "./bin/sisal.mjs" }`; `tools/build_npm.ts` writes the shim
      (with a real `#!/usr/bin/env node` — authored here because dnt mangles a
      source shebang) and marks it executable, and the drift gate snapshots the
      `bin`. The shim self-imports `@sisaljs/migrate/cli`'s `runSisalCli`.
      _Verified:_ from a scratch Node project,
      `node node_modules/.bin/sisal init --target postgres` scaffolds a Node
      config and exits 0.
- [x] **NPM-19 — One Node example per engine family + a "Use from Node" docs
      page.** ✅ Done — [`examples/node/`](../examples/node/) has `sqlite`
      (self-contained via built-in `node:sqlite`), `pg` (postgres.js), and
      `mysql` (mysql2), each a minimal `package.json` + `main.mjs`;
      [`docs/node.md`](node.md) is the guide (install, query, CLI, runtime
      notes). _Verified:_ all three run end-to-end on Node 24 against the linked
      build (sqlite in-memory; pg/mysql against `docker/compose.yaml`).

### Phase 6 — CI & release automation

- [ ] **NPM-20 — CI Node leg.** Add a Node 24 job: `deno task build:npm` +
      `deno task npm:check` + Node test run. _Accept:_ PRs are gated on the npm
      build + Node suite.
- [ ] **NPM-21 — Trusted Publishing setup.** Register the repo + release
      workflow as a trusted publisher for `@sisaljs` in npm settings (OIDC).
      _Accept:_ a dry-run publish authenticates with no `NPM_TOKEN` secret.
- [ ] **NPM-22 — Release workflow.** On the same version tag that drives
      `deno publish`: build, then
      `npm publish ./npm/<pkg> --provenance
  --access public` in **dependency
      order** (`core` → `orm`,`migrate` → adapters → `etl`,`analytics`).
      Idempotent (npm rejects existing versions). _Accept:_ a tagged pre-release
      publishes JSR + npm at identical versions.
- [ ] **NPM-23 — npm advisory audit.** Add `npm audit` / osv over the npm
      dependency set to the audit task. _Accept:_ `deno task audit` (or a
      sibling) covers npm deps.

### Phase 7 — First release & verification

- [ ] **NPM-24 — Dry run.** `npm publish --dry-run` each package; inspect the
      tarball file lists and `exports`. _Accept:_ no stray `*_test.ts`, `.ts`
      sources only where intended, every subpath resolvable.
- [ ] **NPM-25 — Publish `next` dist-tag first.** Ship the full set under
      `--tag next` at a pre-release version; install into a scratch Node project
      per engine. _Accept:_ `npm i @sisaljs/orm @sisaljs/pg pg` then a real
      query/migration runs on Node 24.
- [ ] **NPM-26 — Promote to `latest`.** Once green, publish the paired JSR+npm
      release and move the dist-tag. _Accept:_ `npm i @sisaljs/*` on `latest`
      runs; README install rows show both `deno add` and `npm i`.

---

## Definition of done

- `npm i @sisaljs/<pkg>` runs on **Node 24+** for every engine family.
- The unit suite is green under **Deno and Node**.
- A single tagged release publishes **paired JSR + npm** artifacts at identical
  versions, in dependency order, with provenance, via OIDC (no static token).
- Generated `package.json`s can't drift from `deno.json` (freshness gate).
- One Node example per engine runs end-to-end.

## One-way doors & risks

- **The `@sisaljs` name is now a public contract** once the first non-stub
  version publishes. No rename later.
- **Provenance/OIDC must be configured before the first `latest` publish** — a
  package first published without provenance can add it later, but consistency
  from v1 is cleaner.
- **`node:sqlite` is the only true behavioral fork** (Deno FFI vs Node builtin);
  keep it behind the resolver and cover it in the Node example so regressions
  surface.
- **Dropping CJS** later is easy; adding it after consumers depend on ESM-only
  is not — emit both from the start unless maintenance cost bites.

## Sequencing note

Phase 1 (source portability) is the only part touching shipped library code and
is independently valuable — it can land first, on its own, without committing to
a publish. Everything from Phase 2 on is tooling/CI and reversible until
**NPM-26**.
