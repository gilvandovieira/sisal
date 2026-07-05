---
title: npm Release Readiness
---

# Sisal on npm — what it would take (readiness report, not a release)

This is a **standing readiness report**, not a scheduled deliverable. It records
what must change for Sisal to publish to **npm** alongside JSR and run on
**Node.js 24+**, so the work can be picked up cheaply **if and when** there is
real Node-user demand. It deliberately ships **no npm package**.

> **Status: deferred, demand-driven — a versionless cross-cutting track.**
> Node/npm is on **zero** roadmap gates — nothing in the feature line (MySQL,
> `@sisal/core`, ETL, analytics) depends on it, and it runs entirely on
> Deno/JSR. It **owns no version** (it was previously parked in the now-dropped
> v0.13 slot; see the
> [roadmap cross-cutting tracks](roadmap.md#cross-cutting-tracks-not-on-the-version-line)).
> So this is the safest item to defer. It is **enabled** by the v0.8
> `@sisal/core` extraction (the one clean `.ts`→`.js` build boundary). The
> naming decision that previously gated it is now **resolved** (scope
> `@sisaljs`, see below), and execution is broken into phased tasks in
> [npm-distribution-plan.md](npm-distribution-plan.md).

## The honest baseline — the repo is already close

A June 2026 Node feasibility audit ran the codebase against real **Node v26.4.0
/ npm 11.16.0** in a throwaway worktree. The finding: the library cores carry
**zero Deno-runtime coupling**, all adapters **inject** their driver, and the
`Deno` global is read defensively via `globalThis`. The blockers are
concentrated in **packaging metadata, module-specifier syntax, one static
import, and the dev toolchain** — not in the library logic.

Probes run under real Node:

| Probe                                                                    | Result                                      |
| ------------------------------------------------------------------------ | ------------------------------------------- |
| Load + run the pure `@sisal/orm` core (relative `.ts`, type-stripped)    | ✅ instantiates and runs real logic         |
| `@sisal/pg` → `@sisal/orm` after adding minimal `package.json` `exports` | ✅ cross-package run                        |
| Load `pg/orm/pool.ts` (static `jsr:@db/postgres` import)                 | ❌ `ERR_UNSUPPORTED_ESM_URL_SCHEME`         |
| Import bare `@sisal/orm` with no `package.json`                          | ❌ `ERR_MODULE_NOT_FOUND` (pure resolution) |
| `import.meta.main`, `node:sqlite` (`DatabaseSync`), `node:test`          | ✅ all present                              |

## The "decide first" blocker — resolved: the npm name is `@sisaljs`

The `@sisal` scope is owned on **JSR** but was **unavailable on npm**. That
naming decision — the one-way door this report flagged as a prerequisite — has
now been made.

> **Decision (2026-07-05): the npm scope is `@sisaljs`.** The org is created and
> owned (`gilvandolucasvieira`, owner), which reserves every `@sisaljs/*` name —
> no squatting is possible and no stub reservation is needed. Deno/JSR keeps
> `@sisal/*`; the two runtimes are independent and `dnt` remaps the scope per
> package at build time.

> Publishing `@sisaljs/orm` to npm is a **one-way door**: once consumers `npm i`
> it, the scope/name is a public contract — renaming later breaks every
> installer. The name is now fixed precisely so no publish commits an undecided
> choice — the exact failure pattern the
> [sequencing audit](roadmap-sequencing-audit.md) warns about.

The alternatives that were weighed and rejected: unscoped packages (`sisal-*` —
`sisal` itself is already taken by an unrelated package) and an alternate scope
(`@sisal-db/*`). The full JSR→npm name map, driver mapping, and the phased task
breakdown now live in the execution plan,
[npm-distribution-plan.md](npm-distribution-plan.md).

## What would have to change (the work, when it happens)

Concentrated and additive — the Deno workflow stays exactly as it is.

1. **Package manifests & workspace resolution.** Add a `package.json` beside
   each `deno.json` (six library packages + a root workspace manifest) with
   `"type": "module"`, `"engines": { "node": ">=24" }`, and an `"exports"` map
   mirroring the `deno.json` subpath exports, pointing at built artifacts. Deno
   keeps reading `deno.json`; Node reads `package.json`. Generate `package.json`
   from `deno.json` with a CI freshness check (same pattern as
   `docs:matrix:check`) so they never drift.
2. **Driver indirection — the six `jsr:`/`npm:` import sites.** Node rejects
   `jsr:`/`npm:` URL schemes. Centralize each adapter's _default_ driver load
   behind a lazy resolver branching on `globalThis.Deno` (injected drivers
   always win). The one behavioral change: `@sisal/pg` imports its driver
   **statically** today (`pg/orm/pool.ts`, `pg/migrate/pool.ts`) — make it lazy,
   defaulting to node-postgres (`pg`) on Node. SQLite → built-in `node:sqlite`;
   libSQL → `@libsql/client`; Neon → `@neondatabase/serverless`.
3. **A build step (`.ts` → `.js`).** All ~271 internal imports carry explicit
   `.ts` extensions (Deno-mandatory); published JS/`.d.ts` must rewrite them, so
   a build is required for npm even though Deno needs none. Recommended: Deno's
   official [`dnt`](https://github.com/denoland/dnt) (rewrites specifiers, emits
   dual ESM/CJS + `.d.ts`, keeps Deno as source of truth, and **remaps the
   `@sisal/*` scope to the chosen npm name** per package). **This is cleanest to
   set up at the v0.8 `@sisal/core` extraction** — one stable boundary to build.
4. **Dual-runtime tests.** The unit suites are ~200 `Deno.test` calls + a
   handful of `@std/assert` symbols. A shared `harness.ts` (`Deno.test` under
   Deno, `node:test` under Node) + a mechanical codemod makes the _same_ files
   run under both. Zero logic change.
5. **CI + publish.** Add a Node 24 leg to CI; extend the release to
   `npm publish` the built artifact behind the same version gate as the JSR
   publish (paired versions never diverge); add `npm audit`/osv over the npm
   lockfile.
6. **CLI + examples (smaller).** A `node:fs` filesystem impl beside the Deno
   one, a `bin/sisal` entry, one Node-native example per engine, and a "Use from
   Node" docs page.

## Keep-the-door-open constraints (cheap, do them anyway)

So deferring costs nothing later:

- **Drivers:** when the MySQL driver is chosen (v0.6/v0.7), pick one that works
  on **Deno _and_ Node**. Free now; avoids a re-pick.
- **No npm-hostile patterns:** keep reading `Deno` via `globalThis`, keep
  drivers injectable, keep the lower-tier modules runtime-agnostic — all already
  true; just don't regress them.

## Trigger / definition of done (if pursued)

- **Trigger:** real Node-user demand. _(The npm name — the other half of the old
  trigger — is now decided: `@sisaljs`.)_
- **Enabler:** the v0.8 `@sisal/core` extraction is in place.
- **Done:** `npm i @sisaljs/*` runs on Node 24+; the unit suite is green under
  Deno **and** Node; a release publishes paired JSR + npm artifacts at identical
  versions in one gated run; one Node example per engine runs end-to-end.
