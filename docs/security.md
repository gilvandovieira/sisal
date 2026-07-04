---
title: Security
---

# Security

This is the single source of truth for Sisal's security posture: a **code-level
audit**, a **living roadmap** of addressed and open concerns, and the
**invariants pinned by tests** so the posture cannot silently regress. For
private disclosure, see
[`SECURITY.md`](https://github.com/gilvandovieira/sisal/blob/main/SECURITY.md).

> **Headline:** the 0.3.0 audit confirmed **no Critical or High-severity
> issues**, and every finding it raised is **resolved** ([SEC-001](#sec-001)
> through [SEC-007](#sec-007)). The **0.9.0 refresh** (2026-07-02) re-audited
> the surface added since and found **no injection path**; the findings it did
> raise ([SEC-008](#sec-008) through [SEC-016](#sec-016)) are all resolved and
> test-pinned. The **v0.11.0 release refresh** (2026-07-04) expands the reviewed
> posture to the full capstone workspace, including `@sisal/etl` and
> `@sisal/analytics`. No new security finding is recorded in this document as
> open, but v0.11 compatibility claims are deliberately scoped: analytics is
> Postgres-first and currently unit/golden-SQL proven except where live
> integration coverage is explicitly named.

## v0.11.0 security refresh addendum

The v0.11.0 refresh treats Sisal as a full workspace release, not only an
analytics package release. The review scope is:

- `packages/core`
- `packages/orm`
- `packages/migrate`
- `packages/etl`
- `packages/analytics`
- `packages/pg`
- `packages/neon`
- `packages/sqlite`
- `packages/libsql`
- `packages/mysql`
- `tools`
- `examples`
- `integration`
- `.github/workflows`
- root/package manifests
- `deno.lock`

Package-by-package security posture:

| Area                       | Primary concerns                                                                                      | Current posture for v0.11.0                                                                                                                                                                                                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@sisal/core`              | SQL injection, identifier validation, raw SQL escape hatches, dialect capability registry             | Values render as bound parameters; identifiers are validated/quoted; `raw()` and DDL expressions remain trusted-code escape hatches; capability registry tests pin dialect/render consistency, including percentile support.                                                                                             |
| `@sisal/orm`               | Destructive update/delete safety, mass assignment, raw query escape hatches, logging/error redaction  | Where-less `update`/`delete` throw unless explicitly unsafe; unknown insert/update keys are rejected; `db.execute`/`db.query` accept trusted SQL only; logs/errors redact values, DSNs, tokens, and driver error causes.                                                                                                 |
| `@sisal/migrate`           | Trusted config boundary, migration SQL parsing/execution, Deno permissions, checksums/history         | `sisal.migrate.ts` is trusted local code; migration files are developer-authored SQL; splitter tests cover strings/comments/dollar quotes; docs recommend narrowing CLI permissions; checksums/history/drift are unit-tested.                                                                                            |
| `@sisal/etl`               | Checkpoint integrity, advisory locks, replay/prune safety, idempotence                                | Runner uses advisory-lock + checkpoint substrate; rollups are generated insert-from-select/upsert statements; replay/backfill refuse pruned windows unless explicitly overridden; unit and PostgreSQL integration tests cover lock/checkpoint/failure behavior.                                                          |
| `@sisal/analytics`         | Generated aggregate/window SQL, capability-gated dialect behavior, structural executor trust boundary | Query descriptors compile through `@sisal/core`; unsupported percentile/window shapes fail closed before execution; `execute(db)` trusts a structural executor with `dialectIdentity` and `execute(Sql)`; current support is Postgres-first and mostly unit/golden-SQL proven until live analytics integration is added. |
| PostgreSQL / Neon adapters | TLS/DSN handling, driver errors, transactions/batch semantics, dialect identity                       | PostgreSQL family keeps execution in adapter packages; Temporal params are normalized; transaction executors are isolated; dialect identity is exposed for ETL/analytics gates. Live PostgreSQL coverage exists for ORM/migrate/ETL surfaces; analytics live proof is tracked for v0.11.                                 |
| SQLite / libSQL adapters   | FFI/native permissions, remote token handling, transaction/batch semantics, dialect identity          | SQLite requires `--allow-ffi`; libSQL/Turso requires URL/token env handling; transaction executors are tested; dialect identity is exposed. Compatibility claims distinguish render/unit support from live integration scenarios.                                                                                        |
| MySQL / MariaDB adapter    | TLS, DSN handling, driver error redaction, affected-row semantics, transaction/batch semantics        | TLS options are explicit and TLS URL params are rejected rather than ignored; bundled pools disable found-rows ambiguity; migration locks are namespaced; MariaDB/MySQL dialect identity drives capability gates.                                                                                                        |
| CI / release               | Pinned actions/images, vulnerable/outdated components, publish provenance, release drift              | Actions and service images are pinned; CI runs docs, matrix, image pinning, audit, tests, type checks, and publish dry-run; `deno task audit` checks npm packages through OSV, with JSR advisory coverage noted as an OSV limitation.                                                                                    |

OWASP-aligned release controls:

| Concern                                     | Sisal control                                                                                                                |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Injection                                   | Values are parameterized; identifiers are validated/quoted; raw SQL APIs are explicit trusted-code boundaries.               |
| Security misconfiguration                   | Adapter docs and CLI guidance call out permissions, TLS, DSNs, driver choices, and preview-layer limits.                     |
| Vulnerable/outdated components              | `deno.lock` is audited through OSV for npm packages; JSR advisory coverage is not claimed where OSV lacks ecosystem support. |
| Sensitive data exposure through logs/errors | SQL parameters, connection strings, tokens, credential-like fields, and driver causes are redacted.                          |
| Least privilege                             | Security docs recommend separate migration/application roles and narrowed Deno permissions for CLI use.                      |
| Supply-chain risk                           | GitHub Actions/images are pinned, generated docs/matrix are checked, and publish dry-runs run in CI/release gates.           |

Coverage honesty for v0.11.0:

- Live integration-proven: existing PostgreSQL, Neon, SQLite, libSQL, MySQL, and
  MariaDB adapter feature suites where named in `integration/`; ETL PostgreSQL
  feature/limits suites when `DATABASE_URL` is provided.
- Unit/golden-SQL proven: core SQL rendering, ORM builders, DDL generation, ETL
  SQL compilation across supported render dialects, and analytics query
  rendering/capability gates.
- Render-proven but not yet live-proven: `@sisal/analytics` execution on real
  PostgreSQL until `integration/analytics_features_test.ts` lands.
- Capability-gated unsupported: percentile helpers outside PostgreSQL and any
  dialect identity that cannot support the exact generated construct.

## Audit basis & methodology

- **Last full audit:** 2026-06-28, branch `release/0.3.0` @
  `3f3a9a49005af2f00695816b44af92471c5e7a28`; Deno 2.8.3 / V8 14.9 / TypeScript
  6.0.3; 176 tracked files.
- **0.9.0 refresh:** 2026-07-02, `main` @
  `c7996202f9fc0766ae2ef0b000a41f77059fcb9d` (v0.9.0). Four-track code re-audit
  of the ~155 commits / ~406 changed files landed since 0.3.0 — core SQL
  construction (the v0.8 `@sisal/core` extraction), all five adapters (the
  MySQL/MariaDB adapter and the opt-in postgres.js driver are new), migrate/CLI
  plus the v0.9 ETL substrate, and CI/supply chain — including empirical probes
  of the MySQL/MariaDB drivers and a fresh OSV pass. A second, independently
  produced agent audit (Codex, same date) was cross-checked and merged into
  these findings: it corroborated the High and both Medium findings, and its
  remaining items are folded into [SEC-014](#sec-014) or resolved by this
  document refresh.
- **v0.11.0 release refresh:** 2026-07-04, branch `features/v0.11.0`.
  Workspace-wide review of the capstone release scope listed above, including
  the new `@sisal/analytics` package, the `@sisal/etl` preview package, all
  adapters, examples, integration tests, docs, CI/release workflows, manifests,
  and `deno.lock`. The refresh focuses on release integrity, layering,
  injection/escape-hatch boundaries, capability-gated SQL generation,
  least-privilege guidance, and support-claim honesty. It does not claim that
  analytics has live integration coverage until the dedicated integration test
  lands.
- **0.9.0 scope:** `packages/{orm,migrate,pg,sqlite,libsql,neon}`, `tools`,
  `scripts`, `.github/workflows`, `docker`, `integration`, `examples`,
  `benchmarks`, `docs`, and the root/package manifests + `deno.lock`. Binary
  assets were reviewed for packaging exposure only.
- **Method:** ran the quality/type/test/docs/publish gates; parsed `deno.lock`
  for the dependency inventory; queried OSV for npm advisories; and manually
  reviewed SQL construction, DDL generation, migration parsing/execution,
  adapter transaction/connection handling, dynamic imports, permissions, CI and
  release workflows, Docker services, examples, and docs.

This is a **living document**: statuses are updated as fixes land, so they may
be ahead of the audited commit. Line citations are as of that commit unless a
resolved finding cites current code by function name.

**0.3.0 surface review.** This refresh re-examined the new public surface added
since the 0.2.0 audit: the P7 query-builder additions (`distinctOn`, `for`
locking, `$count`, `countDistinct`, derived-table/scalar subqueries), the
`exists`/`notExists` predicates, the Postgres array operators, and
`columns.customType`. Operator and subquery values remain bound parameters with
table-qualified identifiers, so they add no new untrusted-string surface. The
`customType` factory exposes the snapshot's existing trusted `dialectType`
escape hatch (developer-authored, emitted verbatim into DDL), already governed
by [SEC-006](#sec-006). The SQLite executor was hardened to serialize work on
its single connection so unrelated calls cannot interleave inside an open
transaction.

**0.9.0 surface review.** The refresh re-examined everything added since 0.3.0.
The `@sisal/core` extraction moved the SQL IR, identifier validation, and the
capability registry without weakening them: values are bound parameters
end-to-end, identifiers are validated at definition and again at render, custom
naming-function output is re-validated, only fixed keyword enums reach the
internal `raw()` uses, and prepared plans (`renderToPlan`/`fillPreparedPlan`)
replay without ever inlining values. The new MySQL/MariaDB adapter follows the
injectable-executor pattern; the advisory-lock lease table name is
regex-validated before DDL interpolation and lock names/owners are bound
parameters. The opt-in postgres.js driver is lazily imported and parameterizes
identically to the default driver. The findings this refresh raises live at the
edges instead: the MySQL family's affected-row semantics break the ETL
substrate's claim protocol ([SEC-008](#sec-008)), its URL path cannot express
TLS ([SEC-009](#sec-009)), driver-attached error properties escape the SEC-003
redaction ([SEC-010](#sec-010), [SEC-011](#sec-011)), and checkpoint pruning,
lock namespacing, CI pinning, release provenance, and two internal DDL
boundaries each have a Low-severity gap
([SEC-012](#sec-012)–[SEC-016](#sec-016)).

### Validation during v0.11.0 release prep

| Command                                | Result                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `deno task fmt:check`                  | Pass (467 files)                                                                                             |
| `deno task test`                       | Pass (557 tests, 61 steps)                                                                                   |
| `deno task audit`                      | Pass — 61 npm packages checked through OSV, **0 known npm advisories**                                       |
| `deno publish --dry-run`               | Pass for the workspace; expected dynamic-import warnings remain for trusted CLI config/adapter loading paths |
| OSV `JSR`/`Deno` ecosystem             | Limitation — JSR remains unindexed by OSV                                                                    |
| Live `@sisal/analytics` integration    | Pending v0.11 hardening task; current analytics coverage is unit/golden-SQL/capability-gate coverage         |
| Final release gate (`deno lint`, docs) | Pending final verification pass                                                                              |

### Validation after the v0.10 hardening pass (fixes for SEC-008–SEC-016)

| Command                                | Result                                                                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `deno task fmt:check`                  | Pass (433 files)                                                                                                              |
| `deno lint`                            | Pass (316 files)                                                                                                              |
| `deno task check`                      | Pass                                                                                                                          |
| `deno task test`                       | Pass (475 passed, 61 steps)                                                                                                   |
| `deno task docs:check`                 | Pass (48/48 modules; 96.9% JSDoc)                                                                                             |
| `deno task check:images`               | Pass (all image refs digest-pinned)                                                                                           |
| Security-invariant + `SEC-`id tests    | Pass (`security_test`, `error_test`, `advisory_lock_test`, `checkpoint_test`, `ddl_hardening_test`, MySQL pool/history tests) |
| OSV npm querybatch (`deno task audit`) | Pass — 61 npm packages, **0 vulnerabilities**                                                                                 |
| OSV `JSR`/`Deno` ecosystem             | Limitation — JSR remains unindexed by OSV                                                                                     |

### Validation at the 0.3.0 audited commit

| Command                                | Result                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| `deno fmt --check`                     | Pass (149 files)                                                                      |
| `deno lint`                            | Pass (105 files)                                                                      |
| `deno task check`                      | Pass                                                                                  |
| `deno task test`                       | Pass (139 passed)                                                                     |
| `deno task docs:check`                 | Pass (31/31 modules; 441 JSDoc)                                                       |
| `deno publish --dry-run --allow-dirty` | Pass (two expected unanalyzable dynamic imports in `packages/migrate/cli.ts`)         |
| `tools/check_release_version.ts 0.3.0` | Pass                                                                                  |
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
`db.execute("…")` / `db.query("…")`, pre-rendered statements handed to
`db.batch` or a checkpoint's `advance`/`prune` statement lists (see the
[SEC-006](#sec-006) addendum), and **secrets** flowing through config and
adapters.

**Out of scope (your database's / app's job):** authn/authz, row-level security
policies, TLS/transport (the driver's responsibility — but see
[SEC-009](#sec-009) for the MySQL-family gap), database-server hardening, and
protecting a user from intentionally running their own malicious migration
config.

---

## The bar: what a safe ORM must do

Aligned with OWASP A03 (Injection) and least-privilege / secret-management
practice — each with Sisal's current status.

| # | Standard                                                               | Sisal                                                              |
| - | ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1 | **Parameterize every value** — never concatenate values into SQL       | ✅                                                                 |
| 2 | **Quote and validate identifiers**                                     | ✅                                                                 |
| 3 | **No SQL from untrusted strings** in the core; escape hatches explicit | ✅                                                                 |
| 4 | **Safe-by-default destructive operations**                             | ✅                                                                 |
| 5 | **Keep secrets and values out of logs and errors**                     | ✅ ([SEC-010](#sec-010), [SEC-011](#sec-011))                      |
| 6 | **Reject unknown columns** (mass assignment)                           | ✅                                                                 |
| 7 | **Enforce referential integrity** the schema declares                  | ✅ ([SEC-001](#sec-001))                                           |
| 8 | **Least privilege & secret-management guidance**                       | ✅ ([SEC-004](#sec-004))                                           |
| 9 | **Supply-chain integrity** of dependencies and CI                      | ✅ ([SEC-002](#sec-002), [SEC-014](#sec-014), [SEC-015](#sec-015)) |

---

## Findings & roadmap

Every audit finding (`SEC-NNN`), its severity, and current status. **Addressed**
items are done and, where relevant, pinned by a test. This document currently
has no open `SEC-` finding. The v0.10 roadmap links below are remediation
history for [SEC-008](#sec-008) through [SEC-016](#sec-016), not current release
blockers; any newly discovered v0.11 issue should receive a new `SEC-` id and
package-specific scope.

| ID                  | Concern                                                | Severity | Status       |
| ------------------- | ------------------------------------------------------ | -------- | ------------ |
| [SEC-008](#sec-008) | MySQL-family found-rows breaks `tryInsert`/lock claims | High     | ✅ Addressed |
| [SEC-009](#sec-009) | MySQL-family URL path cannot require TLS               | Medium   | ✅ Addressed |
| [SEC-010](#sec-010) | Bind values survive in driver error properties         | Medium   | ✅ Addressed |
| [SEC-011](#sec-011) | Redaction pattern & coverage gaps                      | Low      | ✅ Addressed |
| [SEC-012](#sec-012) | ETL checkpoint prune ordering / fail-closed gaps       | Low      | ✅ Addressed |
| [SEC-013](#sec-013) | MySQL migration lock name is server-global             | Low      | ✅ Addressed |
| [SEC-014](#sec-014) | Pinning gaps outside the SEC-002 perimeter             | Low      | ✅ Addressed |
| [SEC-015](#sec-015) | Tag-publish ancestry & pre-commit hook permissions     | Low      | ✅ Addressed |
| [SEC-016](#sec-016) | Core DDL defense-in-depth gaps                         | Low      | ✅ Addressed |
| [SEC-001](#sec-001) | `UNIQUE`/`FOREIGN KEY` constraints not emitted in DDL  | Medium   | ✅ Addressed |
| [SEC-003](#sec-003) | Driver error `cause` may preserve DSNs/tokens          | Medium   | ✅ Addressed |
| [SEC-006](#sec-006) | `raw()` / DDL-expression escape hatches                | Low      | ✅ Addressed |
| [SEC-002](#sec-002) | Mutable GitHub Actions & Docker references             | Medium   | ✅ Addressed |
| [SEC-007](#sec-007) | Dollar-quoted SQL split incorrectly                    | Low      | ✅ Addressed |
| [SEC-004](#sec-004) | Broad Deno permissions in CLI & integration            | Low      | ✅ Addressed |
| [SEC-005](#sec-005) | Migration config is trusted local code                 | Info     | ◻️ Accepted  |

### ✅ Addressed (0.9.0 refresh · fixed in v0.10)

Each fix is pinned by a test named for its `SEC-`id. Full per-task fix direction
lives in the [v0.10 roadmap](v0.10.0-roadmap.md) (T1–T10).

#### SEC-008 — MySQL-family found-rows semantics break `tryInsert` and advisory-lock claims {#sec-008}

**High · resolved.** The advisory-lock claim now **verifies ownership** — it
reads the row back and compares the owner token instead of trusting the insert's
affected-row count, so it is exact on every engine and independent of the
connection's found-rows flag (mutual exclusion holds even against an injected
found-rows-on pool). The bundled `@sisal/mysql` pools additionally disable
`CLIENT_FOUND_ROWS` (mysql2 `flags: ["-FOUND_ROWS"]`, MariaDB
`foundRows: false`) so `tryInsert`'s affected-row contract holds for the shipped
drivers; `AdvisoryLock.renew` stays correct because the lease value changes each
renew. Pinned by a two-claimant `advisory_lock_test` that simulates the
ambiguous count and asserts a single winner, plus pool-config tests. The narrow
`UPDATE`-reports-changed-rows consequence is documented in
`docs/mysql-compatibility.md`.

_Original finding:_ MySQL has no `RETURNING`, so `tryInsert` infers "inserted"
from the driver's affected-row count (`packages/orm/core/write_outcome.ts`:
`inserted: rowCount >= 1`), and `db.tryAdvisoryLock` builds its lease-claim
protocol on that signal (`packages/orm/core/advisory_lock.ts`). Both bundled
drivers connect with the `CLIENT_FOUND_ROWS` protocol flag in effect, under
which a conflicting `INSERT … ON DUPLICATE KEY UPDATE x = x` reports **one found
row instead of zero changed rows** — so the loser of a race also sees
`inserted: true`. Empirically confirmed against MariaDB 11: two concurrent
claimants of the same lock name both returned `acquired: true`, breaking the
mutual-exclusion guarantee the ETL substrate depends on (windowed jobs can
double-run; any future queue-claim helper on the same primitive inherits the
flaw). The MySQL-family integration scenarios for `tryInsert`/`tryAdvisoryLock`
cannot pass against a live server in this state. Fix direction: connect with
found-rows off (mysql2 `flags: ["-FOUND_ROWS"]`, MariaDB connector
`foundRows: false`) — but audit `AdvisoryLock.renew` and every other consumer of
an `UPDATE` row count first, since the flag flips their semantics from "matched"
to "changed" — or move the claim path to an unambiguous strategy and fail closed
where an insert-vs-conflict outcome cannot be proven.

#### SEC-009 — MySQL-family URL connections cannot require TLS {#sec-009}

**Medium · resolved.** `MysqlConnectionOptions` now takes an `ssl` option
(`boolean | MysqlTlsOptions`), forwarded verbatim to mysql2, the MariaDB
connector, and — through the shared connection-source resolver — the migrate
driver. A TLS-relevant URL query param (`ssl-mode`, `sslmode`, `ssl`, …) is now
**rejected** with a typed error rather than silently dropped, so the URL path
can no longer fail open to cleartext. Pinned by pool-config tests (`ssl`
forwarding and URL-param rejection).

_Original finding:_ `MysqlConnectionOptions` has no TLS/SSL field, and the URL
convenience path builds both driver configs without `ssl`
(`packages/mysql/orm/pool.ts`, `packages/mysql/orm/mariadb_pool.ts`);
`?ssl-mode=…` URL query parameters are silently dropped, so a URL that _asks_
for TLS still connects in cleartext — the path fails open. Workaround today:
inject a pre-configured `pool`/`client` carrying the driver's TLS options. Fix:
add explicit TLS options to `MysqlConnectionOptions`, forward them to mysql2,
the MariaDB connector, and the migrate driver alike, document strict-TLS
examples, and reject unrecognized security-relevant URL parameters instead of
dropping them.

#### SEC-010 — Bind values survive in driver-attached error properties {#sec-010}

**Medium · resolved.** `redactErrorCause` now recursively sanitizes a preserved
driver cause: it drops bind/statement properties (`parameters`, `sql`, `values`,
…), masks credential-named properties (`password`, `uri`, `authToken`, …), and
recurses nested `cause` chains and `AggregateError.errors`, with a depth/cycle
guard. Our own `SisalError` subclasses pass through unchanged (already redacted,
so `instanceof`/`details` survive). Pinned by `packages/core/error_test.ts`
(bind-value drop, DSN/credential masking, nested/aggregate recursion).

_Original finding:_ [SEC-003](#sec-003)'s redaction covers a preserved driver
cause's `message` and `stack`, but raw bind values reach serializable
**properties** of the cause: the MariaDB connector appends parameter values to
error text (`logParam` behavior), mysql2 attaches the offending statement as
`err.sql`, and postgres.js attaches the `parameters` array as an enumerable
property. `redactSecrets` targets credential patterns (DSN userinfo,
token-bearing parameters), not arbitrary bind values, so a sensitive value bound
into a failing query can surface when an application or test reporter serializes
`error.cause`. Fix: sanitize enumerable cause properties (drop or summarize
`parameters` / `sql` / driver `config` objects; recurse nested causes and
`AggregateError`), disable value-echoing driver options by default, and pin with
adapter-shaped error fixtures for mysql2, MariaDB, postgres.js, libSQL, and
Neon.

#### SEC-011 — Redaction pattern and coverage gaps {#sec-011}

**Low · resolved.** `redactSecrets` now covers `encryptionKey`, masks URL
passwords containing `@`/`/` (lazy match to the `@host` boundary), and redacts
SQL grant/role credentials (`IDENTIFIED BY '…'`, `PASSWORD '…'`). `NeonError`
now extends `SisalError`, inheriting its message/cause/details redaction, and
`SisalError` passes `details` (including `details.sql`) through the redactor.
Pinned by `packages/core/error_test.ts`.

_Original finding:_ Three gaps in the [SEC-003](#sec-003) machinery: (1)
`redactSecrets` misses the `encryptionKey` parameter name and fails to mask URL
passwords containing `@` or `/`; (2) `NeonError` extends `Error` directly rather
than `SisalError`, so it must self-apply redaction on every construction path
instead of inheriting it; (3) `MigrationError` attaches `details.sql` unredacted
— a failing migration statement like `CREATE USER app IDENTIFIED BY 'pw'` would
echo the password into serialized details. Fix: broaden the parameter-name list,
tolerate reserved characters in URL userinfo, route `NeonError` through
`SisalError`, and pass `details.sql` through `redactSecrets`.

#### SEC-012 — ETL checkpoint prune ordering and fail-closed gaps {#sec-012}

**Low · resolved.** `prune` now raises the horizon **first**, then deletes
(`db.batch([horizon, ...deletes])`), so a crash between the two statements
leaves the horizon ahead of the delete (conservative), never behind. The
non-atomic `db.batch` fallback the original finding describes has since been
removed entirely — `db.batch` now throws `ORM_TRANSACTION_UNSUPPORTED` when a
driver can supply neither `batch` nor `transaction`, so the horizon-first order
is defense in depth. The `unsafeAllowPrunedReplay` override now emits a
`console.warn` instead of passing silently, and `etlCheckpoint` fails closed
with `ORM_DIALECT_UNSUPPORTED` on the `generic` dialect. Pinned by
`checkpoint_test.ts` (horizon-first order, generic guard, override warning).

_Original finding:_ `etlCheckpoint`'s `prune` issues its deletes **before**
advancing the retention horizon. Under the ORM's non-atomic `db.batch` fallback
(drivers without native batch execute statements sequentially), a failure
between the two steps leaves rows deleted with the horizon still behind them —
`assertReplayable` then vouches for a window that can no longer be replayed,
violating the replay guarantee that `ORM_REPLAY_PRUNED` exists to protect. Safe
order: advance the horizon first, then delete. Related hardening:
`unsafeAllowPrunedReplay` suppresses the guard silently (it should at least
log), and the checkpoint helpers do not fail closed on the `generic` dialect.

#### SEC-013 — MySQL migration lock name is server-global {#sec-013}

**Low · resolved.** The default migration lock is now namespaced by the current
database — the store resolves `SELECT DATABASE()` and locks
`GET_LOCK('sisal:migrate:<db>')` (hashed suffix if the composed name would
exceed the 64-char ceiling), so unrelated projects on a shared server no longer
contend. An explicit lock id is still honored verbatim and validated before a
session is opened. Pinned by a `history_test` asserting the database-scoped
name.

_Original finding:_ The MySQL migrate driver serializes runners with
`GET_LOCK('sisal:migrate')`, but MySQL user locks are **server-scoped**, not
per-database: every Sisal project on a shared server contends for the same name,
and a stuck or hostile co-tenant session can hold it indefinitely, blocking
unrelated deployments' migrations (availability impact only — no data risk).
Fix: namespace the lock name with the current database (`sisal:migrate:<db>`);
the PostgreSQL advisory lock is already per-database.

#### SEC-014 — Pinning gaps outside the SEC-002 perimeter {#sec-014}

**Low · resolved.** The integration workflow's `mysql:8.4` / `mariadb:11`
service containers and the example `docker-compose.yml` images are now
digest-pinned; a new `deno task check:images` (`tools/check_image_pinning.ts`,
wired into CI) fails on any `image:`/`FROM` reference lacking an `@sha256:`
digest; and `--no-lock` is dropped from the `perf:*` tasks. Pinned by the CI
guard itself.

_Original finding:_ [SEC-002](#sec-002) pinned GitHub Actions and the `docker/`
images, but three references sit outside that perimeter: the integration
workflow's **service containers** still use mutable `mysql:8.4` / `mariadb:11`
tags (`.github/workflows/integration.yml`; Dependabot's `docker` ecosystem does
not scan workflow `services:` blocks, so these drift silently), the example
compose files use mutable tags, and the `perf:*` tasks run with `--no-lock`,
bypassing the lockfile integrity the rest of the workspace gets from `--frozen`.
The integration workflow runs with `contents: read`, so the blast radius is
bounded. Fix: digest-pin the service images and example images, add a CI check
that rejects `image:` references without `@sha256:`, and drop `--no-lock`.

#### SEC-015 — Tag-publish ancestry and pre-commit hook permissions {#sec-015}

**Low · resolved.** The publish workflow now runs a **tag-push ancestry guard**
— it fetches `origin/main` (checkout deepened to full history) and refuses to
publish unless `git merge-base --is-ancestor "$GITHUB_SHA" origin/main`
succeeds, so a tag on an off-main commit cannot reach the OIDC publish path. The
doc tasks the pre-commit hook invokes now use `--allow-run=deno` instead of a
blanket `--allow-run`.

_Original finding:_ The publish workflow's "refuse outside `main`" guard covers
`workflow_dispatch` runs only; a **tag push** publishes whatever commit the tag
points at, even one not on `main`, so tag-push rights alone suffice to route an
unreviewed commit through the OIDC publish path. Fix: assert ancestry in the tag
path (`git merge-base --is-ancestor "$GITHUB_SHA" origin/main`). Also, the
installed pre-commit hook runs with a blanket `--allow-run`; it only needs
`--allow-run=deno`.

#### SEC-016 — Core DDL defense-in-depth gaps {#sec-016}

**Low · resolved.** `renderPortableExpression` now **rejects** a portable DDL
expression that carries a bound parameter (a typed `OrmError`, matching the
generated-column path) instead of emitting a dangling `$1`, and index / unique /
check **constraint names** are validated as plain identifiers at the core
boundary (the same discipline table and column names get). Pinned by
`packages/core/ddl_hardening_test.ts`.

_Original finding:_ Two internal-boundary gaps, neither reachable from untrusted
input today: `renderPortableExpression` (`packages/core/table.ts`) silently
**drops bound parameters** when rendering an expression into a snapshot, leaving
a dangling `$1` placeholder in generated DDL where its sibling paths reject
instead; and index/unique/check **constraint names** are not validated at the
core boundary — currently safe only because every DDL generator quote-escapes
them on emission.

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

**0.9.0 addendum.** Two more trusted-string surfaces of the same class are now
named explicitly: `db.query("…", params)` accepts raw SQL text exactly like
`db.execute("…")` (same runner, same trust expectation), and `db.batch` plus a
checkpoint's `advance`/`prune` statement lists accept pre-rendered `SqlQuery`
objects that execute verbatim. All of them are `raw()`-class, developer-
authored inputs — never build their SQL text from runtime strings. Root
`SECURITY.md` lists them alongside the original escape hatches.

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

_Residual (0.9.0 refresh) — resolved in v0.10:_ the splitter now models
PostgreSQL `E'…'` escape-string backslash escapes (a `\'` no longer ends the
string) and **nested** block comments (depth-tracked, so an inner `*/` does not
close the outer comment), so a `;` inside either construct is no longer treated
as a top-level terminator. This was correctness hardening on trusted migration
files, not an injection surface. Pinned by the new `sql_split_test` cases.

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

**Refresh 2026-07-02 (v0.9.0):** the lockfile now inventories **61 npm**
packages (the MySQL/MariaDB drivers and the opt-in postgres.js driver are the
notable additions); OSV `querybatch` again returned **0 vulnerabilities**, and
JSR remains unindexed. The new database drivers (`postgres`, `mysql2`,
`mariadb`) are pure JavaScript and integrity-locked; native code still enters
only through the libSQL client's platform packages and `@db/sqlite`'s
`@denosaurs/plug` download; no installed package declares lifecycle scripts.

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
- [x] Turn off found-rows semantics (or adopt an unambiguous claim strategy) for
      the MySQL family so `tryInsert`/`tryAdvisoryLock` cannot double-grant; add
      live-conflict regression tests. — [SEC-008](#sec-008)
- [x] Add TLS options to `MysqlConnectionOptions`, forwarded to mysql2, the
      MariaDB connector, and the migrate driver; stop silently dropping
      `ssl-mode` URL params. — [SEC-009](#sec-009)
- [x] Sanitize enumerable driver-error properties (`parameters`/`sql`/config
      objects, nested causes, `AggregateError`); disable value-echoing driver
      options. — [SEC-010](#sec-010)
- [x] Close redaction gaps: `encryptionKey`, reserved characters in URL
      passwords, `NeonError` inheritance, `details.sql`. — [SEC-011](#sec-011)
- [x] Advance the checkpoint horizon before pruning; log
      `unsafeAllowPrunedReplay`; fail closed on `generic`. — [SEC-012](#sec-012)
- [x] Namespace the MySQL migration lock by database. — [SEC-013](#sec-013)
- [x] Digest-pin workflow service images and example compose images; drop
      `--no-lock` from the `perf:*` tasks. — [SEC-014](#sec-014)
- [x] Enforce main-ancestry on tag-push publishes; narrow the pre-commit hook to
      `--allow-run=deno`. — [SEC-015](#sec-015)
- [x] Reject bound parameters in portable DDL expressions; validate constraint
      names at the core boundary. — [SEC-016](#sec-016)

---

## Reporting a vulnerability

See
[`SECURITY.md`](https://github.com/gilvandovieira/sisal/blob/main/SECURITY.md)
for the private disclosure channel. Report suspected vulnerabilities privately
rather than opening a public issue, and allow time for a fix before disclosure.
