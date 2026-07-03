---
title: Roadmap Sequencing Audit (v0.6 → v0.11)
---

# Sisal roadmap sequencing audit — gates, not items

> **Scope change (July 2026).** The v0.12 `@sisal/dashboard`, v0.13 DuckDB /
> external-OLAP, and v0.14 native/Rust milestones were **dropped** — Sisal will
> not pursue a presentation-mapping layer or native acceleration, and DuckDB
> specifically is off the table. (A future external database target such as a
> time-series DB stays a _possible, unplanned_ post-v0.11 direction.) This audit
> originally covered v0.6 → v0.14; the gates tied to the dropped milestones
> (**G7** DuckDB-after-IR, **G8** native-after-benchmark, and the
> transformable-AST defect **GI-3 / Defect 3**) are now **moot** and marked as
> such below. The two live defects — **GI-1** (dialect capability
> variant/version axis) and **GI-2** (ETL-runner substrate) — are unaffected and
> remain the authoritative sequencing concerns through v0.11.

This is a **second-pass sequencing audit** of the forward plan
(`docs/roadmap.md`, `docs/architecture.md`, `docs/v0.6.0-roadmap.md` →
`docs/v0.11.0-roadmap.md`, and the twelve `examples/advanced-sql-contracts/`).
It deliberately ignores the per-task trackers (A1–A6, B1–B8, C1–C6, …) — those
are explicitly disposable. It audits the thinner layer of **gates**:
cross-cutting invariants that must hold regardless of which line items survive
to do the work.

The question this doc answers: **does dropping items the way they are designed
to be dropped ever let a gate get crossed without its real, capability-level
prerequisite landing?** It originally found **three** such gates; after the July
2026 scope change **two remain live** (the third, GI-3, is moot with DuckDB
dropped).

Every claim below is verified against source (`packages/orm/core/*.ts`,
`packages/orm/schema.ts`, `tools/feature_matrix.ts`) — the project's own
"verified, not assumed" standard, not roadmap prose.

## Status legend

| Symbol | Meaning                                                                      |
| ------ | ---------------------------------------------------------------------------- |
| 🟥     | Gate can be crossed without its real prerequisite — sequencing defect        |
| 🟧     | Prerequisite scoped only as investigation/decision, not as a usable artifact |
| 🟩     | Gate is self-protecting / adequately sequenced                               |
| ⚪     | Gate moot/dropped after the July 2026 scope change (v0.12–v0.14 removed)     |

Prerequisite scoping is classified, per the audit brief, as: **(a)** real
implementation work scoped somewhere; **(b)** scoped only as an
investigation/decision deliverable that may not yield a usable artifact; **(c)**
not scoped anywhere.

---

## The gate list (re-derived)

Eight gates are stated, plus three that are **implicit** in the per-version docs
without ever being named as cleanly as the rest — and it is the implicit ones
that fail.

| #        | Gate                                                                                                                                                                                                   | Source                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| G1       | ORM/core never depends on ETL/analytics/dashboard; adapters never import each other; dashboard never renders                                                                                           | `architecture.md:64-72`; restated in each of v0.10/v0.11/v0.12 |
| G2       | Substrate before dependents — `@sisal/core` (public, **versioned** IR) stabilizes before ETL/analytics/dashboard compile into it                                                                       | `roadmap.md:35`; `architecture.md:88-99`; v0.8                 |
| G3       | Investigate before build — readiness (v0.6/v0.7) precedes public packages (v0.10+)                                                                                                                     | `roadmap.md:24-26,43-48`                                       |
| G4       | MySQL investigated v0.6 → implemented v0.7; pg stays the reference                                                                                                                                     | `roadmap.md:58-59`                                             |
| G5       | Pushdown-first ETL: job-definition + single-run runner + **external** scheduler                                                                                                                        | `roadmap.md:53-57`; v0.10                                      |
| G6       | Explicit capability surface — adapters declare capabilities explicitly, from **one tested source of truth**                                                                                            | `architecture.md:68-69`; v0.8:128-129; v0.9                    |
| ~~G7~~   | ~~DuckDB only **after** the analytics IR exists, as an execution target~~ — **dropped July 2026** (no DuckDB milestone)                                                                                | ~~v0.13~~                                                      |
| ~~G8~~   | ~~Native/Rust only **after** benchmark evidence~~ — **dropped July 2026** (no native milestone)                                                                                                        | ~~v0.14~~                                                      |
| **GI-1** | _(implicit)_ The dialect/capability **identity primitive** must be expressive enough for the matrix it promises                                                                                        | nowhere — the gap behind G2+G4+G6                              |
| **GI-2** | _(implicit)_ The ETL-runner correctness substrate (lock + checkpoint + idempotency + atomic advance) must be **built and tested**, not just designed, before the runner ships                          | nowhere — the gap behind G3+G5                                 |
| ~~GI-3~~ | _(implicit)_ ~~The transformable-AST question must be **decided or made additively reservable** before the IR is frozen public~~ — **moot** (seam shipped in v0.8; DuckDB, its only consumer, dropped) | ~~the gap behind G2+G7~~                                       |

---

## The audit matrix

| Gate                 | Gate-crossing item (first deliverable that crosses it)                                                                                                                                                                                                                            | True (capability-level) prerequisite                                                                                                                                                                                                                          | Scoping status                                                                                                                                                                                                                         | Risk if dropped/reordered                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GI-1 / G6** 🟥     | v0.9 "capability descriptor — authoritative & machine-checked" (built on the v0.8 descriptor extracted into the frozen `@sisal/core`)                                                                                                                                             | A descriptor **key space** that (i) distinguishes the five adapter packages and six matrix targets — `pg`, `neon`, `sqlite`, `libsql`, `mysql`, `mariadb` — and (ii) carries a **version axis** (MySQL 8.0.21, MariaDB 10.5/11.7, SQLite 3.31, Postgres 14 …) | **(c)** not scoped — every doc says "per-dialect descriptor" and the primitive it is "generalized from" (`dialectGuard` over `SqlDialect`) is whole-dialect, 4-value, no version                                                       | The authoritative matrix structurally cannot express the very distinctions v0.9's own scope hardens (neon-vs-pg serverless caveats, libsql-vs-sqlite, MySQL-vs-MariaDB). It freezes into the public `@sisal/core` at v0.8 → adding the axis later breaks the exported `dialectGuard` signature and render contract (the snapshot is versioned via `SCHEMA_SNAPSHOT_VERSION` and can migrate; the guard/IR surface cannot) |
| **G4** 🟥            | v0.7 ships `@sisal/mysql` as a real published package                                                                                                                                                                                                                             | A variant/version primitive to express the MySQL 8 / 5.7 / MariaDB 10.2 / 10.5 splits the adapter's own contract tabulates (`RETURNING`, `WITH RECURSIVE`, `JSON_TABLE`, partial indexes)                                                                     | **(b)** v0.6 C3/C5 + v0.7 open questions scope only "design dialect/version handling" and "decide one adapter with feature flags vs documented divergences"; the primitive itself is **(c)**                                           | v0.7 publishes a `"mysql"` dialect that cannot carry the split `12-mysql-compatibility.md:91-99` requires. The split lands ad-hoc in the executor or is dropped; the later correct fix breaks both the published adapter **and** the frozen `@sisal/core` dialect type. v0.7 closes **before** v0.8 — the fix window shuts at the wrong time                                                                              |
| ~~**GI-3 / G7**~~ ⚪ | ~~v0.13 DuckDB investigation~~ — **MOOT (July 2026)**: DuckDB milestone dropped, so the seam has no consumer. In any case v0.8 **shipped** the additive `SqlChunk.meta` extension point (`sql_meta_seam_test.ts`), so the mitigation the original defect asked for already landed | ~~An introspectable/transformable IR seam~~ — n/a                                                                                                                                                                                                             | resolved on both axes: consumer dropped **and** seam shipped                                                                                                                                                                           | none — the risk this row described cannot occur now that no milestone depends on transforming the IR                                                                                                                                                                                                                                                                                                                      |
| **GI-2 / G5** 🟧     | v0.10 ships `@sisal/etl` with `run`/`backfill`/`replay` + checkpoint + lock                                                                                                                                                                                                       | (a) portable lock abstraction; (b) checkpoint-table contract **and** its ownership decision; (c) idempotency + atomic load+advance                                                                                                                            | **(b)** v0.6 A2/A3/A4 are all P2/🔴 "design/document only"; v0.9 "formalize the lock strategy" is in _hardening items_, **not** v0.9 acceptance criteria; checkpoint ownership is an **open question in v0.6, contract 09, and v0.10** | v0.10's acceptance **hard-requires** "concurrent runs are serialized by the lock strategy" and idempotent/resumable runs. If A2/A3/A4 stay design-only or drop, the runner ships on a correctness substrate that was never built or tested → "concurrent runs corrupt rollups" (v0.10's own risk wording, `v0.10:78-79`)                                                                                                  |
| **G1** 🟧            | v0.10/v0.11 (first packages that compile into core)                                                                                                                                                                                                                               | `@sisal/core` exposes enough (statement-assembler decision) that ETL/analytics need not reach into `@sisal/orm`; checkpoint ownership must not silently add an `etl → migrate` edge                                                                           | **(b)** v0.8 open question "expose the statement assembler, or compile fragments + a thin helper?" is unresolved; the checkpoint "managed system table" branch implies an edge absent from `architecture.md`'s graph                   | If the assembler stays private and ETL needs SELECT/CTE assembly, v0.10 is pushed to depend on `@sisal/orm` (G1 violation) or reimplement it. The checkpoint "migrate system table" resolution adds an `etl → migrate` dependency the architecture diagram does not show                                                                                                                                                  |
| **G2** 🟩 (mostly)   | v0.8 extract `@sisal/core` + versioned IR                                                                                                                                                                                                                                         | Clean lower-tier DAG with no upward edges                                                                                                                                                                                                                     | **(a)** real and **already true** in source (`errors ← sql ← {operators,columns} ← table ← {builders,relations} ← database`; the one cross-cut is inverted behind `QUERY_BUILDER_BRAND`)                                               | Extraction itself is low-risk (file-moves). The risk is **what gets frozen** at extraction — see GI-1 and GI-3, which ride on this same release                                                                                                                                                                                                                                                                           |
| **G3** 🟩/🟧         | v0.10/v0.11 packages                                                                                                                                                                                                                                                              | v0.6/v0.7 investigations produce **usable artifacts**, not just reports                                                                                                                                                                                       | Mixed — the ETL _rollup_ spine is real and probed (v0.5 builder); the _runner_ substrate (GI-2) is design-only                                                                                                                         | The investigation-vs-artifact gap is concentrated in GI-2; the rest of G3 is sound                                                                                                                                                                                                                                                                                                                                        |
| ~~**G8**~~ ⚪        | ~~v0.14 native investigation~~ — **DROPPED (July 2026)**: no native/Rust milestone                                                                                                                                                                                                | ~~A reproducible benchmark harness~~ — n/a                                                                                                                                                                                                                    | n/a                                                                                                                                                                                                                                    | none — milestone removed                                                                                                                                                                                                                                                                                                                                                                                                  |

---

## The three real defects, in prose

### Defect 1 — the dialect identity primitive cannot express the matrix it promises (GI-1, generalizes seed #1)

This is the central finding and it subsumes the first seed.

**Source-verified facts:**

- `SqlDialect = "postgres" | "sqlite" | "mysql" | "generic"` — a closed 4-value
  union, no version axis (`core/sql.ts:25`).
- The schema-snapshot dialect is a _second_ closed 4-value union,
  `SisalDialectName = "generic" | "postgres" | "sqlite" | "mysql"`
  (`schema.ts:13-17`).
- **The render dialects collapse six capability targets into four render
  dialects:** `LIBSQL_DIALECT = "sqlite"` (`libsql/orm/dialect.ts:4`); Neon
  renders as `"postgres"`; MySQL and MariaDB both render through `"mysql"`.
  There is no `"neon"`, `"libsql"`, or `"mariadb"` render-dialect value.
- The capability mechanisms operate at **whole-dialect** granularity only:
  `dialectGuard(construct, unsupported: readonly SqlDialect[])` (`sql.ts:625`),
  the `guard` chunk's `unsupported: readonly SqlDialect[]` (`sql.ts:64-68`), and
  `dialectSql`'s `variants: { [D in SqlDialect]?: Sql }` (`sql.ts:69-74`). Real
  call sites only ever pass `["sqlite"]` / `ARRAY_OP_UNSUPPORTED = ["sqlite"]`
  (`operators.ts:150`, `builders.ts:982,1038`). The guard even hardcodes the
  string `"it is PostgreSQL-only"` (`sql.ts:564`).
- **The two key spaces already diverge in the repo today.** The feature matrix
  keys on `ADAPTERS = ["pg", "neon", "sqlite", "libsql", "mysql", "mariadb"]`
  (`tools/feature_matrix.ts:15`) — it _does_ distinguish neon-from-pg,
  libsql-from-sqlite, and MySQL-from-MariaDB. The IR `dialectGuard` does not.
  They are reconciled today only by `docs:matrix:check` (every ✅/⚠️ backed by a
  named test), **not** by a shared descriptor.

**Why this is a sequencing defect, not just a missing feature.** v0.8's
deliverable is "capability gates become declarative — a per-dialect capability
descriptor… **the single source the v0.9 matrix and the `dialectGuard` both
read**" (`v0.8:128-129`), and v0.9 makes that descriptor "authoritative and
machine-checked." But:

1. The matrix is six-way; `dialectGuard` is 4-way. "One source both read"
   requires reconciling key spaces that **do not match**, and no doc names that
   reconciliation as work.
2. The contracts require a **version axis** that neither key space has — and not
   just for MySQL. Verified across the corpus:
   - `12-mysql-compatibility.md:91-99`: `RETURNING` MySQL 8 ❌ vs MariaDB ✅
     (10.5+); `WITH RECURSIVE` MySQL 8+ ✅ / 5.7 ❌; window functions 8+ vs
     MariaDB 10.2+.
   - `07-recursive-comments.md`: cycle/depth guard needs **Postgres 14+**
     `CYCLE`.
   - `11-generated-columns-indexes.md`: SQLite **3.31+** (stored/virtual),
     **3.9+** (expression indexes); MySQL **8.0.13+** (functional); MySQL has
     **no** partial indexes.
   - `10-json-table-extraction.md`: MySQL **5.7 lacks `JSON_TABLE`**; "very old
     SQLite without JSON1."
   - `02/04`: "older SQLite frame mode" must throw a typed guard.
3. The contracts demand these be **typed guards** ("verified, not assumed,"
   "fail guarded → feature-matrix"). A typed guard that can only say
   `unsupported: ["sqlite"]` _cannot_ say "needs SQLite ≥ 3.31" — so the user
   gets a raw engine error, which is exactly the failure mode the guard exists
   to prevent.
4. **The freeze happens at the wrong time.** `@sisal/mysql` ships at v0.7;
   `@sisal/core`'s IR is frozen public at v0.8; the matrix becomes authoritative
   at v0.9 — all **before** the dependents that need the finer granularity
   (v0.10 ETL, v0.11 analytics) are built. By the time a concrete consumer
   proves the version axis is needed, the primitive is a public contract and the
   axis is a breaking change.

The historical `12-mysql-compatibility.md` pressure-contract framing makes the
erasure visible: it called for "a **fifth column**" while its own table
(`:91-99`) showed **six** distinct profiles (pg/neon, sqlite/libsql, MySQL 8,
MariaDB). The current six-column matrix fixes the document-level count, but the
single-`"mysql"` render token still erases the variant split unless the
capability descriptor carries it.

### Defect 2 — the ETL-runner correctness substrate is "design-only," but the runner's acceptance criteria hard-require it (GI-2)

The cleanest "drop lets the gate cross without its prerequisite" case.

- v0.10 acceptance (`v0.10:92-100`) **hard-requires**: "A run is idempotent… and
  resumable," "`backfill(range)` reproduces a historical range
  deterministically," and "**Concurrent runs are serialized by the lock
  strategy**."
- Its prerequisites are all design-only and disposable: v0.6 **A2** (locking),
  **A3** (checkpoint), **A4** (idempotent load + replay) are P2 / 🔴 /
  "document"/"design, don't ship."
- v0.9 picks up "Advisory-lock equivalence — formalize the SQLite/libSQL lock
  strategy the ETL runner will use" — but only in _specific hardening items_,
  **not** in v0.9's acceptance criteria. And a v0.9 open question invites
  resolving SQLite-family ETL as "Postgres-first, documented gap," which quietly
  deletes the SQLite/libSQL lock strategy entirely.
- `08-job-queue-locking.md:67-72` names the load-bearing artifact: "**A portable
  'claim next' abstraction** … **this is the missing piece (A2)** … It must
  encode the locking _capability_, not assume Postgres … **design in v0.6, used
  by the v0.10 runner**." `09-idempotent-backfill.md:50-55` adds the atomicity
  invariant: the load and the watermark advance "must commit **together** (one
  transaction / `db.batch`)."

So the chain is: a P2/🔴 design item (A2) → a non-acceptance-gated v0.9
"formalize" → a v0.10 **hard acceptance criterion**. Drop A2 (it is designed to
be droppable) and nothing downstream forces it back in until v0.10 fails its own
acceptance — at which point the runner's public API (`run`/`backfill`/`replay`,
the checkpoint table, the lock contract) is already shipped around a model that
was never built. v0.10's own risk register agrees: "concurrent runs corrupt
rollups."

A second structural decision rides along: **checkpoint-table ownership** is an
open question in v0.6, again in `09-idempotent-backfill.md:60-62`, and again in
`v0.10:85-90` — "`@sisal/etl`-managed vs a `@sisal/migrate` system table?" —
while v0.10 _ships_ the checkpoint table. Resolving it toward "migrate system
table" adds an `etl → migrate` edge that `architecture.md`'s dependency graph
does not contain (it shows `etl → core (+ adapter)`). That makes it a G1
concern, not just an ETL detail.

### Defect 3 — the transformable-AST mitigation is named but not acceptance-gated (GI-3, refines seed #2)

> **MOOT (July 2026).** This defect is resolved on both axes. (1) v0.8
> **shipped** the additive `SqlChunk.meta` extension point — the exact
> mitigation this section asked for — proven by
> `packages/orm/sql_meta_seam_test.ts` (see v0.8 item 4, 🟢). (2) Its only named
> consumer, v0.13 DuckDB pushdown, was **dropped**, so nothing now needs to
> transform the IR at all. The analysis below is retained as a record of why the
> seam was worth shipping.

- Verified the IR is compose-only: expressions are stored already-lowered
  (`eq()` flattens immediately into chunks; `core/sql.ts`), there is no
  introspectable relational AST (`architecture.md:93-99`; `v0.8:40-44`).
- v0.8 recommends "keep the fragment IR as the compile target; add a
  transformable AST **only** if a concrete consumer needs it — defer the
  decision with a **documented extension point**" (`v0.8:92-95`).
- v0.13's open question names this exact deferral as a potential blocker: "Does
  compiling to DuckDB need the **transformable AST** deferred in v0.8, or can it
  compile from the same fragment IR with a DuckDB dialect?" (`v0.13:66-67`).

The defect is narrower than "the IR can't be transformed." It is that v0.8's
acceptance criterion only requires "the transformable-AST **decision** is
documented (build / defer / reject)" — it does **not** require shipping the
"documented extension point" that is the actual mitigation. A decision to defer
is satisfiable by a paragraph; the additive seam that lets the AST be added
later without a version bump is what protects v0.13, and it is not a deliverable
anyone is accountable for. Once `@sisal/core`'s IR is public and versioned
(v0.8), retrofitting introspectability without the reserved seam is a breaking
change.

---

## Where the seed findings land

**Seed #1 (`SqlDialect` closed union, no version axis; MySQL version splits at
v0.7): AGREE, verified, and generalize.** The source is exactly as described
(`sql.ts:25,625,64-74,564`). Two amendments: (1) there are **two** such unions
(`SqlDialect` _and_ `SisalDialectName`), and both also collapse neon/libsql and
the MySQL/MariaDB split, so the primitive cannot express the **six capability
targets the matrix already uses** — the version axis is the second missing axis,
not the only one; (2) the version-gating requirement is **pervasive, not
MySQL-specific** — Postgres 14 `CYCLE`, SQLite 3.9/3.31, MySQL
8.0.13/8.0.20/8.0.21, MariaDB 10.2/10.5 all appear across contracts 07/10/11/12.
The right framing is GI-1 (the capability descriptor's granularity), with seed
#1 as its sharpest instance.

**Seed #2 (compose-only fragment IR shipped public at v0.8 while
introspection/rewriting is deferred; v0.13 anticipates needing it): AGREE on the
premise, with one refinement.** v0.13 frames the need as _conditional_ ("does it
**need** the AST, or can it compile from fragments with a DuckDB dialect?") — so
it is not a certain block. The precise defect is GI-3: the deferral's
load-bearing mitigation (the "documented extension point") is recommended in
prose but is **not** an acceptance-gated deliverable, while the _decision_ to
defer is. Close that gap and the deferral becomes safe. **(Resolved July 2026:
v0.8 shipped the seam and v0.13 DuckDB was dropped — see the MOOT note on Defect
3.)**

---

## Concrete fixes (tied to mechanisms already in the docs)

Written as acceptance-criteria edits so they can be folded into the existing
roadmap docs. Each attaches to a mechanism the plan already names.

### Fix 1 — give the v0.9 capability descriptor a variant + version axis, and pin its shape in v0.8 (addresses GI-1, G4, G6)

Add to **v0.8 acceptance criteria** (the IR-freeze release — this is the last
non-breaking opportunity):

- The capability descriptor's key is **`(adapter, optional version-range)`**,
  not `SqlDialect`. It distinguishes the current `tools/feature_matrix.ts`
  `ADAPTERS` values (`pg`/`neon`/`sqlite`/`libsql`/`mysql`/`mariadb`) and admits
  a version predicate per capability.
- `dialectGuard(construct, unsupported: SqlDialect[])` is generalized to a
  **capability predicate** the descriptor evaluates, so a guard can express
  "requires MySQL ≥ 8.0.21," "Postgres ≥ 14 for `CYCLE`," "SQLite ≥ 3.31" — and
  fail **typed** when unmet, not as a raw engine error.
- The descriptor is the literal single source `dialectGuard`, the feature
  matrix, and ETL/analytics read (closing the key-space divergence that exists
  today between `feature_matrix.ts:15` and `sql.ts:25`).

Add to **v0.7**: `@sisal/mysql`'s published dialect identity carries the variant
from day one (snapshot dialect `"mysql"` + a
`{ variant: "mysql" | "mariadb",
version }` field), so adding MariaDB or
older-MySQL handling later is **additive, not breaking**. If the team genuinely
wants to defer MariaDB, this is the cheap insurance that keeps the deferral
reversible.

### Fix 2 — make the ETL-runner substrate acceptance-gated before v0.10 (addresses GI-2, G5, G1)

- Promote the v0.6 A2/A3/A4 _outputs_ into **v0.9 acceptance criteria**: the
  portable claim/lock abstraction (`08`), the checkpoint contract (`09`), and
  the atomic load+advance invariant (`09:50-55`) each get a per-engine test —
  matching how v0.9 already acceptance-gates insert-from-select and the float8
  fix. (Today they live in v0.9's _hardening items_, which are droppable.)
- **Resolve checkpoint-table ownership in v0.8/v0.9**, before v0.10 ships the
  table. If the answer is "migrate-managed," add the `etl → migrate` edge to
  `architecture.md`'s graph explicitly so G1 stays honest.
- If the substrate genuinely slips, scope v0.10 as **Postgres-only at the API
  level** (the lock/checkpoint surface is capability-gated and SQLite/libsql
  return a typed "unsupported job shape" rather than a silently-degraded runner)
  — consistent with v0.10's own "document any unsupported job shapes rather than
  silently degrading."

### Fix 3 — ship the extension point, not just the decision (addresses GI-3, G7) — ✅ DONE, now moot

**Outcome (July 2026).** This fix was **adopted and shipped**: v0.8 changed its
acceptance criterion to require the additive seam, and it landed as the
`SqlChunk.meta` extension point, proven by `packages/orm/sql_meta_seam_test.ts`.
Its motivating consumer (v0.13 DuckDB) was subsequently **dropped**, so the seam
now stands purely as low-cost future-proofing. No further action. The original
recommendation is preserved below for the record.

- Change the **v0.8 acceptance criterion** from "the transformable-AST decision
  is documented" to "the versioned IR **reserves an additive seam** for later
  introspection (e.g. an opaque origin/`meta` field on `SqlChunk`, or an
  optional un-lowered expression capture behind a flag) such that adding a
  transformable AST is a minor, non-breaking version bump — proven by a fixture
  that round-trips a fragment through the seam."

### Fix 4 — close the v0.8 statement-assembler question before v0.10 (addresses G1)

The v0.8 open question "expose the statement assembler, or have downstream
compile fragments + a thin helper?" determines whether `@sisal/etl`/
`@sisal/analytics` can avoid depending on `@sisal/orm`. Make it a **v0.8
deliverable with a decision**, since v0.10/v0.11 are the first packages that
would otherwise be tempted across the G1 boundary.

---

## Where the sequencing is sound (for calibration)

- **G2 extraction itself is low-risk.** The lower-tier DAG already has no upward
  edges and the one cross-cut is inverted behind `QUERY_BUILDER_BRAND` (verified
  in `sql.ts:699-726`). The risk is _what freezes at extraction_ (GI-1/GI-3),
  not the move.
- **G7 DuckDB-after-IR and G8 native-after-benchmark were well-protected** while
  they existed — both were gated on prerequisites that were their own first
  deliverables (the IR; the benchmark report). Both milestones were **dropped in
  July 2026**, so the gates are retired rather than merely satisfied.
- **The dependency-direction gate (G1) is enforced redundantly** — every
  downstream roadmap restates "`@sisal/orm` must not depend on …". The only soft
  spots are the two _latent_ edges noted above (assembler exposure, checkpoint
  ownership).

---

## Appendix — empirical validation of GI-1 / seed #1 against live engines

The headline finding (a single version/variant-blind `"mysql"` token is
insufficient) is not left as documentary claim. It was executed against three
live engines — **MySQL 8.0.46, MySQL 5.7.44, MariaDB 11.8.8** (Docker) — using
the **exact SQL the Sisal core renders today under the `"mysql"` dialect**.

The rendered output was produced by the real `@sisal/orm` core
(`createDatabase({ dialect: "mysql" })` → builder →
`renderSql(…, { dialect:
"mysql" })`), not hand-written:

```
insert into `kv` (`k`, `v`) values (?, ?) returning *
insert into `kv` (`k`, `v`) values (?, ?) on conflict (`k`) do update set `v` = excluded.v
```

Note the renderer emits **identical** SQL regardless of which MySQL-family
target is meant — it has no axis on which to differ. Executing it (and the
correct per-target SQL the contracts cite) gives:

| Construct                                      | Sisal emits under `"mysql"` | MySQL 8.0.46 | MySQL 5.7.44 | MariaDB 11.8 | Axis exposed                                   |
| ---------------------------------------------- | --------------------------- | :----------: | :----------: | :----------: | ---------------------------------------------- |
| `INSERT … RETURNING *`                         | yes (identical)             |  ❌ `1064`   |  ❌ `1064`   |      ✅      | **variant** (MariaDB ≠ MySQL)                  |
| `INSERT … ON CONFLICT DO UPDATE`               | yes (identical)             |  ❌ `1064`   |  ❌ `1064`   |  ❌ `1064`   | latent path wrong for whole family (C2)        |
| `INSERT … ON DUPLICATE KEY UPDATE`             | _(not emitted)_             |      ✅      |      ✅      |      ✅      | the correct upsert C2 must switch to           |
| `WITH RECURSIVE …` (contract 07)               | _(no builder)_              |      ✅      |  ❌ `1064`   |      ✅      | **version** (5.7 ≠ 8)                          |
| `JSON_TABLE(…)` (contract 10)                  | _(no builder)_              |      ✅      |  ❌ `1064`   |  ✅ (11.7+)  | **version** (5.7 ≠ 8; MariaDB < 11.7 ≠ ≥ 11.7) |
| functional index `((length(v)))` (contract 11) | _(no builder)_              |      ✅      |  ❌ `1064`   |  ❌ `1064`   | **variant** (MariaDB ≠ MySQL 8)                |

(`1064` = `ER_PARSE_ERROR` — the engine rejects the statement as a syntax error,
the exact "raw engine error" a typed `dialectGuard` is supposed to pre-empt.)

**Why this is the kill-shot for a 4-value, version-less `SqlDialect`.** Look at
the directions:

- `RETURNING` is supported on **MariaDB** but **not** MySQL 8 → the capability
  must distinguish _variant_.
- the functional index is supported on **MySQL 8** but **not** MariaDB → the
  variant distinction runs the **opposite** way for a different feature.
- `WITH RECURSIVE` / `JSON_TABLE` are supported on **8** but not **5.7** → the
  capability must also distinguish _version within MySQL_. (`JSON_TABLE` is
  version-gated inside MariaDB too — added in **11.7** — so the version axis
  isn't even MySQL-specific.)

No single `"mysql"` enum member, and no whole-dialect
`dialectGuard(construct, ["mysql"])`, can simultaneously encode "yes-on-MariaDB
/ no-on-MySQL" **and** "yes-on-MySQL-8 / no-on-MariaDB" **and** "yes-on-8 /
no-on-5.7." The variant axis and the version axis are **both required and
independent** — which is exactly **Fix 1**: the capability descriptor's key must
be `(adapter/variant, version-range)`, decided at v0.8 before the IR (and the
published `@sisal/mysql` from v0.7) freeze. This is the empirical form of GI-1
and confirms seed #1 against real engines, not prose.

**Reproduce (any engine, ~1 min).** Point-in-time run on 2026-06-30 against
images `mysql:8.0` (8.0.46), `mysql:5.7` (5.7.44), `mariadb:11` (11.8.8). The
probes are self-contained — paste each into any server's `mysql`/`mariadb`
client and observe accept vs `1064`:

```sql
CREATE TABLE kv (k INT PRIMARY KEY, v TEXT NOT NULL); INSERT INTO kv VALUES (9, 'x');
-- Sisal's current "mysql" render output (both wrong on MySQL; RETURNING ok on MariaDB):
INSERT INTO `kv` (`k`, `v`) VALUES (1, 'a') RETURNING *;
INSERT INTO `kv` (`k`, `v`) VALUES (9, 'a') ON CONFLICT (`k`) DO UPDATE SET `v` = excluded.v;
-- correct/target per engine/version:
INSERT INTO `kv` (`k`, `v`) VALUES (9, 'b') ON DUPLICATE KEY UPDATE `v` = VALUES(`v`);
WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 3) SELECT SUM(n) FROM c;
SELECT * FROM JSON_TABLE('[{"a":1}]', '$[*]' COLUMNS(a INT PATH '$.a')) jt;  -- MariaDB needs 11.7+
CREATE INDEX ix_fn ON kv ((LENGTH(v)));
```

## One-line summary

The disposable per-task trackers are fine. The danger was concentrated in three
**structural decisions that get committed to a public surface before the
consumer that proves them out exists**: the dialect/capability granularity
(frozen at v0.8, needed at v0.10+), the ETL-runner correctness substrate
(shipped at v0.10, scoped only as v0.6 "design"), and the IR's transformability
seam (frozen at v0.8). The third was resolved (the seam shipped in v0.8) and is
now moot anyway (DuckDB dropped July 2026); the first two remain live and are
fixable cheaply, by attaching one acceptance criterion each to a mechanism the
roadmap already names — most of all the **v0.9 capability descriptor**, which
should be given its key space and version axis at v0.8, before the IR is frozen.
