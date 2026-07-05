---
title: npm Release Runbook
---

# npm Release Runbook

How a paired **JSR + npm** release of Sisal is cut. The `Publish` workflow
(`.github/workflows/publish.yml`) does the work; this is the operator checklist.
Companion to [npm-distribution-plan.md](npm-distribution-plan.md) (Phase 7).

## One-time setup — OIDC Trusted Publishing

npm authenticates the release via GitHub OIDC (no stored `NPM_TOKEN`), but a
trusted publisher is configured **per package**, and a package's settings page
exists only after its first publish. For a brand-new scope you therefore
**bootstrap with a token once**, then switch to tokenless.

1. **Bootstrap token.** npmjs.com → Access Tokens → Granular Access Token, scope
   **`@sisaljs`** read+write, short expiry. Add it as the repo secret
   **`NPM_TOKEN`** (the publish workflow's npm steps pick it up via
   `NODE_AUTH_TOKEN`).
2. **First release** (below) creates all 10 packages using the token, with
   provenance.
3. **Register trusted publishers.** For each of the 10 packages
   (`core, orm, migrate, pg, neon, sqlite, libsql, mysql, etl, analytics`):
   npmjs.com → `@sisaljs/<pkg>` → Settings → Trusted Publisher → GitHub Actions:
   - Organization/user: `gilvandovieira`
   - Repository: `sisal`
   - Workflow filename: `publish.yml`
   - Environment: _(blank)_
4. **Go tokenless.** Delete the `NPM_TOKEN` secret. Subsequent releases publish
   over OIDC with zero stored secrets.

## Cutting a release

1. **Land the work on `main`** (merge the PR). The workflow refuses to publish a
   tag that is not an ancestor of `main`.
2. **Version consistency** is already gated: every `packages/*/deno.json` and
   the migrate CLI's `DEFAULT_ADAPTER_VERSION` must equal the tag. Check
   locally:
   ```sh
   deno run --allow-read tools/check_release_version.ts <version>
   ```
3. **Dry run** (optional, recommended): GitHub → Actions → Publish → Run
   workflow on `main`, `dry_run: true`. Runs `deno publish --dry-run` and
   `npm_publish.ts --dry-run` — no writes.
4. **Tag and push:**
   ```sh
   git checkout main && git pull
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```
   The workflow runs the full gate battery, then `deno publish` (JSR), then
   `build:npm:all` + `tools/npm_publish.ts` (npm, dependency order,
   `--provenance`, idempotent — versions already on the registry are skipped).

## Notes

- **CHANGELOG**: promote `Unreleased` → `## X.Y.Z - <date>` before tagging.
- **Idempotent**: a re-run (e.g. JSR succeeded, npm half-failed) safely skips
  what is already published and finishes the rest.
- **One-way door**: the first publish makes `@sisaljs` and every package name a
  permanent public contract — no rename afterward.
