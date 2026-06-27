---
title: Security
---

# Security

This is the single source of truth for Sisal's security posture: a **code-level
audit**, a **living roadmap** of addressed and open concerns, and the
**invariants pinned by tests** so the posture cannot silently regress. For
private disclosure, see
[`SECURITY.md`](https://github.com/gilvandovieira/sisal/blob/main/SECURITY.md).

> **Headline:** the audit confirmed **no Critical or High-severity issues**. The
> ORM query path is the strongest control surface — values are bound parameters,
> identifiers are validated before quoting, parameter values are never logged,
> destructive operations require an explicit opt-in, and migrations use
> checksums plus locks. All three medium findings raised by the audit — missing
> constraint emission, credential leakage through driver error causes, and
> unpinned CI/Docker references — have since been **resolved** (see
> [SEC-001](#sec-001), [SEC-003](#sec-003), and [SEC-002](#sec-002)). The
> dollar-quoted migration splitter finding is also resolved (see
> [SEC-007](#sec-007)).

## Audit basis & methodology

- **Last full audit:** 2026-06-27, branch `release/0.2.0` @
  `fac83f1f94c1d5b79cd5c5f1c8b14bd979714cf3`; Deno 2.8.3 / V8 14.9 / TypeScript
  6.0.3; 166 tracked files.
- **Scope:** `packages/{orm,migrate,pg,sqlite,libsql,neon}`, `tools`, `scripts`,
  `.github/workflows`, `docker`, `integration`, `examples`, `benchmarks`,
  `docs`, and the root/package manifests + `deno.lock`. Binary assets were
  reviewed for packaging exposure only.
- **Method:** ran the quality/type/test/docs/publish gates; parsed `deno.lock`
  for the dependency inventory; queried OSV for npm advisories; and manually
  reviewed SQL construction, DDL generation, migration parsing/execution,
  adapter transaction/connection handling, dynamic imports, permissions, CI and
  release workflows, Docker services, examples, and docs.

This is a **living document**: statuses are updated as fixes land, so they may
be ahead of the audited commit. Line citations are as of that commit unless a
resolved finding cites current code by function name.

### Validation at the audited commit

| Command                                | Result                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| `deno fmt --check`                     | Pass (140 files)                                                                      |
| `deno lint`                            | Pass (100 files)                                                                      |
| `deno task check`                      | Pass                                                                                  |
| `deno task test`                       | Pass (113 → now 121 passed)                                                           |
| `deno task docs:check`                 | Pass (31/31 modules; 413 → now 418 JSDoc)                                             |
| `deno publish --dry-run --allow-dirty` | Pass (two expected unanalyzable dynamic imports in `packages/migrate/cli.ts`)         |
| `tools/check_release_version.ts 0.2.0` | Pass                                                                                  |
| OSV npm querybatch                     | Pass — 33 npm packages, **0 vulnerabilities**                                         |
| OSV `JSR`/`Deno` ecosystem probe       | Limitation — OSV returns `Invalid ecosystem`; JSR advisory coverage cannot be claimed |

---

## Scope & threat model

Sisal is a **driverless ORM and migration toolkit that runs inside your
application process** — no network surface, sessions, or auth of its own. The
audit assumed these attacker models:

- application-controlled **values** reaching the SQL builders;
- application-controlled **identifiers or raw SQL** fragments;
- malicious or compromised **migration files** or local `sisal.migrate.ts`;
- accidental **credential disclosure** via CLI, examples, CI, logs, or errors;
- compromised **dependencies** or transitive npm packages;
- compromised **GitHub Actions, Docker images, or release workflows**;
- **concurrent** migration runners;
- misconfigured **database URLs** or remote libSQL/Neon endpoints.

**Trust boundary.** Schema definitions, query builders, and `` sql`…` ``
templates are _code you author_ and are trusted. The untrusted surface is
runtime **values**, any **string** passed to `raw(...)` / `identifier(...)` /
`db.execute("…")`, and **secrets** flowing through config and adapters.

**Out of scope (your database's / app's job):** authn/authz, row-level security
policies, TLS/transport (the driver's responsibility), database-server
hardening, and protecting a user from intentionally running their own malicious
migration config.

---

## The bar: what a safe ORM must do

Aligned with OWASP A03 (Injection) and least-privilege / secret-management
practice — each with Sisal's current status.

| # | Standard                                                               | Sisal                    |
| - | ---------------------------------------------------------------------- | ------------------------ |
| 1 | **Parameterize every value** — never concatenate values into SQL       | ✅                       |
| 2 | **Quote and validate identifiers**                                     | ✅                       |
| 3 | **No SQL from untrusted strings** in the core; escape hatches explicit | ✅                       |
| 4 | **Safe-by-default destructive operations**                             | ✅                       |
| 5 | **Keep secrets and values out of logs and errors**                     | ✅                       |
| 6 | **Reject unknown columns** (mass assignment)                           | ✅                       |
| 7 | **Enforce referential integrity** the schema declares                  | ✅ ([SEC-001](#sec-001)) |
| 8 | **Least privilege & secret-management guidance**                       | ✅ ([SEC-004](#sec-004)) |
| 9 | **Supply-chain integrity** of dependencies and CI                      | ✅ ([SEC-002](#sec-002)) |

---

## Findings & roadmap

Every audit finding (`SEC-NNN`), its severity, and current status. **Addressed**
items are done and, where relevant, pinned by a test; **partial**/**open** items
are the roadmap.

| ID                  | Concern                                               | Severity | Status       |
| ------------------- | ----------------------------------------------------- | -------- | ------------ |
| [SEC-001](#sec-001) | `UNIQUE`/`FOREIGN KEY` constraints not emitted in DDL | Medium   | ✅ Addressed |
| [SEC-003](#sec-003) | Driver error `cause` may preserve DSNs/tokens         | Medium   | ✅ Addressed |
| [SEC-006](#sec-006) | `raw()` / DDL-expression escape hatches               | Low      | ✅ Addressed |
| [SEC-002](#sec-002) | Mutable GitHub Actions & Docker references            | Medium   | ✅ Addressed |
| [SEC-007](#sec-007) | Dollar-quoted SQL split incorrectly                   | Low      | ✅ Addressed |
| [SEC-004](#sec-004) | Broad Deno permissions in CLI & integration           | Low      | ✅ Addressed |
| [SEC-005](#sec-005) | Migration config is trusted local code                | Info     | ◻️ Accepted  |

### ✅ Addressed

#### SEC-001 — Generated DDL emits `UNIQUE` and `FOREIGN KEY` constraints {#sec-001}

**Medium · resolved.** At the audited commit, `CREATE TABLE` emitted columns and
primary keys but **not** unique constraints or foreign keys, so a `.unique()` /
`.references()` declaration was silently dropped — weakening data integrity that
may back tenant isolation, ownership links, or invitation tokens.

`generate{Postgres,Sqlite}UpStatements` now emit them: `.unique()` → `UNIQUE`,
and `.references(table, column, { onDelete?, onUpdate? })` → `FOREIGN KEY` with
referential actions. **Postgres** adds FKs as `ALTER TABLE … ADD … FOREIGN KEY`
_after_ every `CREATE TABLE` (so the snapshot's alphabetical table order can't
cause a forward-reference error); **SQLite** keeps them inline; **libSQL**
aliases the SQLite DDL. Pinned by
`parity: foreign keys + actions emit as ALTER after CREATE` (pg) and
`parity: SQLite emits UNIQUE + inline FOREIGN KEY with actions`.

The remaining schema-integrity surface is now also emitted: a `defineTable`
extras callback (`defineTable(name, columns, (t) => [...])`) declares composite
`primaryKey`, named/composite `unique`, `index`/`uniqueIndex`, and `check`, all
rendered into DDL (`CHECK` columns unqualified for portability; indexes as
`CREATE INDEX`). Pinned by
`parity: table extras — composite PK, named unique,
check, index(es)` in the
pg/sqlite parity tests (parity roadmap **P6**, done).

#### SEC-003 — Credentials are redacted from errors {#sec-003}

**Medium · resolved.** Sisal's own error `details` never carried credentials
(only the parameterized SQL text), but wrappers preserved the **driver's
original error as `cause`**, which for `@db/postgres`/`@libsql/client`/Neon can
embed a DSN, password, or token — leaking if an application or CI serializes
nested causes.

The base `SisalError` constructor now passes its `message` and any preserved
`cause` through **`redactSecrets`** (`packages/orm/error.ts`), which masks
passwords in a URL's userinfo (`scheme://user:***@host`) and the values of
credential-bearing parameters (`password`, `authToken`, `token`, `apiKey`,
`secret`, …); the original is kept untouched when there is nothing to redact.
Because `OrmError` and `MigrationError` extend `SisalError`, **every adapter and
the migrate/CLI path is covered**; `NeonError` (which extends `Error` directly)
applies the same helpers. `redactSecrets` is exported from `@sisal/orm` for
redacting your own logs. Pinned by
`security: credentials are redacted from
errors`.

#### SEC-006 — Raw SQL & DDL-expression escape hatches {#sec-006}

**Low · resolved.** The ordinary query path parameterizes values and validates
identifiers; `raw()` is the only unsanitized SQL hatch, and DDL **default
expressions** (`SisalColumnDefault` `kind: "expression"`) plus the Postgres
`dialectType` field are emitted verbatim. These are developer-authored escape
hatches, dangerous only if application-controlled strings reach them. Closed on
three fronts:

- **Enforced lint rule.** `tools/lint/sisal_lint.ts` ships a
  `sisal/no-raw-interpolation` rule (enabled in the root `deno.json`) that fails
  `deno lint` on an interpolated template literal passed to ``raw(`…${…}`)`` —
  the precise injection footgun — steering values to the parameterizing `sql`
  template or `identifier(name)`. The few trusted internal uses (fixed join /
  operator / set-op keywords) carry justified
  `// deno-lint-ignore sisal/no-raw-interpolation` comments. Pinned by
  `tools/lint/sisal_lint_test.ts`. ``db.execute(`…`)`` is intentionally **not**
  linted — it is the general runner for trusted DDL/migration strings, so a rule
  would be noisy; an application can widen the rule's `calleeName` check to
  cover it. Adopt the rule by copying the plugin into your project and adding it
  to your `deno.json` `lint.plugins`.
- **Documented trusted inputs.** DDL default expressions and `dialectType` are
  marked trusted, never-sanitized schema inputs in their JSDoc
  (`packages/orm/schema.ts`) — set them only from developer-authored schema
  code, never from a runtime value (literal defaults are escaped; expression
  defaults are not).
- **Existing controls** stand: `raw()` rejects non-strings and carries a "does
  not sanitize" warning, and `packages/orm/security_test.ts` pins parameter
  binding, identifier rejection, and where-less mutation blocking.

#### SEC-002 — GitHub Actions & Docker references are pinned {#sec-002}

**Medium · resolved.** Workflows referenced actions by moving tags
(`actions/checkout@v4`, `denoland/setup-deno@v2`, the Pages actions) and Docker
images by mutable tags (`postgres:16/17/18`,
`ghcr.io/neondatabase/wsproxy:latest`), so a retargeted or compromised upstream
tag could run unreviewed code — the highest-impact path being the publish
workflow's `id-token: write`.

Every third-party action is now pinned to a **full commit SHA** (with a trailing
`# v4`-style version comment) across `ci.yml`, `publish.yml`, `pages.yml`, and
`integration.yml`; every Docker image — the three Postgres servers, the Neon
`wsproxy`, and the runner's `denoland/deno` base — is pinned to an immutable
`@sha256:` **digest**, and the `:latest` Neon proxy tag is digest-pinned. A
`.github/dependabot.yml` (`github-actions` + `docker` ecosystems, weekly) keeps
the SHAs and digests refreshed and reviewable. The existing narrow release
permissions, OIDC publishing, and tag/version checks are unchanged.

#### SEC-007 — PostgreSQL dollar-quoted SQL stays intact {#sec-007}

**Low · resolved.** At the audited commit, `splitSqlStatements`
(`packages/migrate/cli.ts`) tracked single/double quotes and comments but not
PostgreSQL dollar-quoted strings (`$$ … $$`, `$tag$ … $tag$`), so a `;` inside a
trusted function/procedure body could be treated as a statement terminator,
causing migration failures or partial execution.

The splitter now recognizes untagged and tagged dollar-quote delimiters and
ignores semicolons until the matching closing delimiter. `$1`/`$2` parameter
placeholders are not treated as dollar quotes. Pinned by
`splitSqlStatements: dollar-quoted bodies stay whole`.

#### SEC-004 — Scoped permission examples are documented {#sec-004}

**Low · resolved.** The migration CLI shebang and `deno task sisal` grant
read/write/env/net/FFI for convenience, and integration suites use `-A`. These
are developer defaults; root `SECURITY.md` now also documents **least-privilege
scoped variants** so production/CI runs can narrow the blast radius of a
malicious migration file, config, dependency, or test path:

```sh
# generate (no database connection): read config, write migrations
deno run --allow-read=. --allow-write=./migrations \
  jsr:@sisal/migrate/cli generate

# migrate against Postgres: only the DSN env var and the DB host
deno run --allow-read=. --allow-env=DATABASE_URL \
  --allow-net=db.example.com:5432 jsr:@sisal/migrate/cli migrate

# migrate against libSQL/Turso: the URL + token env vars and the Turso host
deno run --allow-read=. --allow-env=TURSO_DATABASE_URL,TURSO_AUTH_TOKEN \
  --allow-net=your-db.turso.io:443 jsr:@sisal/migrate/cli migrate
```

SQLite uses `@db/sqlite`, which loads a native library on first run, so its
migrations need the broader
`--allow-ffi --allow-read --allow-write --allow-env
--allow-net` (see the
SEC-002 supply-chain note). Keep broad `deno task sisal` for local development;
reach for the scoped flags in CI and production.

### ◻️ Accepted boundary

#### SEC-005 — Migration config is trusted local code {#sec-005}

**Informational · accepted + documented.** The CLI dynamically imports
`sisal.migrate.ts`, which is executable local code running under the CLI's
permissions — an expected migration-tool trust boundary, since a malicious
config can read env, write files, or reach the network. The second dynamic
import loads default adapters from package-owned specifier constants (not
user-controlled), version-checked by `tools/check_release_version.ts`. This is
now **explicit**: `sisal init` writes a scaffold whose header marks the config
as trusted, executable code that runs with the CLI's permissions and tells you
to read secrets from the environment (`renderConfigTemplate` in
`packages/migrate/cli.ts`). The boundary remains accepted by design.

---

## Positive security controls

Verified strengths (citations as of the audited commit; functions are stable):

- **Values become parameters**, never inlined SQL (`sql` template →
  `serializeSqlValue` → `paramSql`); `limit`/`offset` are parameterized too.
- **`Sql` fragments cannot be serialized as values**
  (`ORM_SERIALIZATION_FAILED`).
- **Identifiers are validated then quoted** — `validateIdentifierPath` rejects
  embedded `"`/`` ` ``, control chars, and `..`; `quoteIdentifier` wraps per
  dialect.
- **`raw()` is explicitly unsanitized/trusted-only** and rejects non-strings.
- **Logging records SQL text, not bound values** — `#run` logs `{ sql }` and
  `{ rowCount, durationMs }` only; logging is wrapped so it can't throw into a
  query.
- **Where-less `update`/`delete` require `.unsafeAllowAllRows()`**.
- **DDL generators withhold destructive changes** into a separate `destructive`
  array; generated DDL is additive-only.
- **Mass-assignment guard** — `assertTableColumn` rejects unknown columns on
  insert/update/upsert.
- **DDL default literals are single-quote-escaped** (`'…''…'`).
- **Migrations** detect checksum mismatches, acquire/release locks when the
  store supports them, and use Postgres advisory locks; adapter transactions
  isolate the handle and roll back on failure.
- **Release hygiene** — CI runs with `contents: read`; the publish workflow
  grants `id-token: write` only there, validates release-tag versions, refuses
  manual publish outside `main`, and runs `deno install/task --frozen` for
  reproducibility.

These are pinned by `packages/orm/security_test.ts` (parameter binding,
identifier rejection, escape-hatch strictness, where-less guards, no-param-in-
errors, and credential redaction) and the pg/sqlite parity tests (constraint
emission).

---

## Dependency & advisory review

Lookup date 2026-06-27. `deno.lock` inventory: **14 JSR** and **33 npm**
packages. OSV `querybatch` returned **0 vulnerabilities** across the 33 npm
packages; OSV rejects the `JSR`/`Deno` ecosystems (`Invalid ecosystem`), so
complete advisory coverage for JSR dependencies cannot be claimed.

Observations:

- Runtime npm usage is confined to explicit adapter/benchmark boundaries
  (`@libsql/client`, Neon transitive deps, `drizzle-orm` in benchmarks only).
- `deno.lock` records resolved versions + integrity; CI uses `--frozen`.
- `@db/sqlite` pulls a prebuilt **native library** via `@denosaurs/plug` over
  the network on first run — treat as an operational supply-chain risk for
  locked-down deployments (offline cache / checksum). Tracked with SEC-002.

_Automated:_ `deno task audit` (`tools/check_advisories.ts`) prints the
`deno.lock` SBOM and fails on any OSV npm advisory; the weekly
`.github/workflows/advisories.yml` runs it. JSR dependencies are listed for the
record but, as the audit noted, OSV does not index the JSR ecosystem.

---

## Follow-up checklist

- [x] Emit column-level `UNIQUE` and `FOREIGN KEY` constraints (with referential
      actions) in generated PostgreSQL/SQLite/libSQL DDL. — [SEC-001](#sec-001)
- [x] Redact DSNs, passwords, and auth tokens from error messages and preserved
      driver causes; add adapter-aware tests. — [SEC-003](#sec-003)
- [x] Add core ORM security tests (parameter binding, identifier rejection, raw
      misuse, where-less refusal, no-param-in-errors, redaction).
- [x] Add a root `SECURITY.md` with a disclosure channel and least-privilege
      guidance.
- [x] Emit `CHECK`, index, table-level/composite, and named constraints via the
      `defineTable` extras callback. — [SEC-001](#sec-001) / parity **P6**
- [x] Document DDL default expressions and `dialectType` as trusted inputs and
      ship the enforced `sisal/no-raw-interpolation` lint rule. —
      [SEC-006](#sec-006)
- [x] Add scoped Deno-permission examples for CLI and integration commands. —
      [SEC-004](#sec-004)
- [x] Pin GitHub Actions to commit SHAs and Docker images to digests (and a
      Dependabot config to refresh them). — [SEC-002](#sec-002)
- [x] Recognize PostgreSQL dollar-quoted strings in the migration splitter; add
      regression tests. — [SEC-007](#sec-007)
- [x] Document `sisal.migrate.ts` as trusted local executable code in CLI docs
      and scaffolds. — [SEC-005](#sec-005)
- [x] Add an automated advisory/SBOM workflow for npm deps (`deno task audit` +
      `.github/workflows/advisories.yml`).

---

## Reporting a vulnerability

See
[`SECURITY.md`](https://github.com/gilvandovieira/sisal/blob/main/SECURITY.md)
for the private disclosure channel. Report suspected vulnerabilities privately
rather than opening a public issue, and allow time for a fix before disclosure.
