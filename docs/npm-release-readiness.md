---
title: npm Release Readiness
---

# Sisal on npm — readiness report and shipped distribution notes

This began as a **standing readiness report** for what would need to change for
Sisal to publish to **npm** alongside JSR. As of v0.12, that distribution track
has shipped: Sisal remains JSR-first and Deno-native, and matching npm packages
are published for **Node.js 24+** under the `@sisaljs/*` scope.

> **Status: shipped as a cross-cutting distribution track.** Node/npm still owns
> no feature milestone: MySQL, `@sisal/core`, ETL, and analytics remain
> Deno/JSR-first work. The npm build is generated from the Deno source tree,
> published in lockstep with JSR at identical versions, and tracked in
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

## What changed

Concentrated and additive — the Deno workflow stays exactly as it is.

1. **Generated npm manifests.** `@sisal/*` JSR packages map to `@sisaljs/*` npm
   packages. The npm manifest graph is generated from `deno.json` and frozen in
   `docs/npm-manifests.json` so exports, versions, sibling dependencies, and
   optional driver peers cannot drift silently.
2. **Runtime-aware driver loading.** Adapter drivers are lazy and injectable.
   Deno keeps the JSR/`npm:` driver paths; Node resolves npm peers or
   `node:sqlite` where appropriate.
3. **npm build step.** `deno task build:npm:all` builds ESM-only npm artifacts
   from the Deno sources, rewrites package scopes/specifiers, and preserves the
   JSR-first source layout.
4. **Dual-runtime tests and examples.** `deno task test:node` runs the unit
   suite under Node, and `examples/node/` demonstrates SQLite, PostgreSQL, and
   MySQL consumers using `@sisaljs/*`.
5. **Paired release automation.** npm publishing runs after JSR publishing on
   the same version gate, with provenance and idempotent checks.

## Keep-the-door-open constraints (cheap, do them anyway)

So deferring costs nothing later:

- **Drivers:** when the MySQL driver is chosen (v0.6/v0.7), pick one that works
  on **Deno _and_ Node**. Free now; avoids a re-pick.
- **No npm-hostile patterns:** keep reading `Deno` via `globalThis`, keep
  drivers injectable, keep the lower-tier modules runtime-agnostic — all already
  true; just don't regress them.

## Definition of done

- `npm i @sisaljs/*` runs on Node 24+.
- The unit suite is green under Deno **and** Node.
- Releases publish paired JSR + npm artifacts at identical versions in one gated
  run.
- Node examples run end-to-end for the supported npm paths.
