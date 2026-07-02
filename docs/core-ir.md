---
title: "@sisal/core — the compile-target contract"
---

# `@sisal/core` — the compile-target contract

The documented, versioned public surface downstream packages (`@sisal/etl`,
`@sisal/analytics`) compile into — the v0.8 item-3 stamp. What this page
declares public is a compatibility commitment; everything else is not.

## The three export surfaces

| Export                          | Commitment                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `@sisal/core`                   | **Stable.** The compile target described below.                                                        |
| `@sisal/core/schema`            | **Stable.** The snapshot contract, independently versioned by `SCHEMA_SNAPSHOT_VERSION` (currently 2). |
| `@sisal/core/unstable-internal` | **None.** `@sisal/orm` builder plumbing; may change in any release. Do not build on it.                |

## The fragment IR (`SQL_IR_VERSION = 1`)

A statement is a `Sql` — a flat list of `SqlChunk`s rendered in one two-phase
pass. The chunk kinds and their render semantics **are the contract**:

| Chunk kind    | Renders as                                                                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`        | verbatim SQL text (from the `sql` tag's literal parts)                                                                                                                |
| `param`       | a positional marker (`$n` on postgres, `?` elsewhere) + bound value; instants tagged `temporal: "instant"` rewrite to naive UTC under `mysql` only                    |
| `placeholder` | a named prepared-plan slot, bound at `PreparedQuery.toSql(values)` time                                                                                               |
| `raw`         | verbatim trusted text (`raw()`; guarded by the `sisal/no-raw-interpolation` lint)                                                                                     |
| `identifier`  | a dialect-quoted identifier (`"a"."b"` / `` `a`.`b` ``)                                                                                                               |
| `operator`    | a dialect-mapped operator (`ilike` → `like` off postgres)                                                                                                             |
| `guard`       | **zero-width**; throws typed `ORM_DIALECT_UNSUPPORTED` when the render identity matches its declarative `unsupported`/`unless` data (fail closed on unknown versions) |
| `dialect`     | the variant for the render dialect, the fallback, or a typed throw                                                                                                    |
| `sql`         | a nested fragment (composition)                                                                                                                                       |

Every chunk optionally carries an opaque **`meta`** annotation (`SqlChunkMeta`)
— renderer-ignored, carried by reference through composition. This is the
reserved additive seam for a future transformable AST (v0.8 item 4): populating
it is a **minor** version bump, never a breaking one.

**Compatibility policy.** `SQL_IR_VERSION` names the render semantics of the
kinds above. Additive changes — new chunk kinds, new optional fields, `meta`
payloads, new capability registry entries — do **not** bump it and arrive as
minor `@sisal/core` releases. A change that makes an existing chunk render
differently would bump it and is expected never to happen: the golden
per-dialect SQL suites (`packages/orm/golden_sql_test.ts`, 62 snapshots across
the construct catalog and prepared-plan checks) pin every construct's exact
text, parameters, and typed errors.

## What the compile target includes

- **Schema primitives** — `defineTable`, `columns` (including generated columns
  via `generatedAs`), constraints, and `createSchemaSnapshot` (the snapshot
  spine).
- **The `sql` tag and fragment primitives** — `sql`, `raw`, `identifier`,
  `joinSql`, `placeholder`, `expr<T>()`, `withSqlChunkMeta`/`sqlChunkMeta`.
- **Expressions** — operators/predicates, aggregates, `filter()`, the date
  helpers (`dateTrunc`/`dateBin`/`dateAdd`/`dateSub`/`dateDiff`/`now`),
  `coalesce`/`greatest`/`least`, and the window primitives (`over`/`WindowSpec`,
  `rank`/`denseRank`/`rowNumber`/`lag`/`lead`).
- **JSON / array helpers** — `arrayExpr`, `jsonExtract`, and `jsonTable` as the
  typed set-returning FROM source for JSON-array projection.
- **The capability registry** — `DIALECT_CAPABILITIES`, `capabilitySupported`,
  `capabilityGuard`, `CAPABILITY_TARGETS`, and the
  `(engine, variant, version-range)` identity (`DialectIdentity`,
  `dialectGuard`/`dialectGuardApplies`, `compareServerVersions`).
- **Statement assembly** — `assembleSelect` and `assembleInsertFromSelect` (the
  item-5 seam): deterministic assemble-from-parts whose output is byte-identical
  to the ORM builder's render for the same statement (pinned by
  `packages/orm/assembly_equivalence_test.ts`). The fluent builders, `Database`
  facade, relations, and function caller are **`@sisal/orm`**, not core.
- **The renderer** — `renderSql(fragment, dialect | identity)` and the error
  (`OrmError`/`SisalError`) and `Logger` contracts.

## What is deliberately not promised

No transformable/introspectable AST (the `meta` seam reserves the path); no
query planner; no statement shapes beyond the assembly seam above; nothing
exported from `unstable-internal`.
