---
title: "@sisal/core extraction — migration notes"
---

# `@sisal/core` extraction — migration notes

v0.8 extracted `@sisal/orm`'s lower tier into **`@sisal/core`** (roadmap item
2): the schema primitives, fragment SQL IR, expression operators, the dialect
capability registry, and the dialect-aware renderer. The fluent query builders,
`Database` facade, relations, and typed function caller stay in `@sisal/orm`.

## Do I need to change anything?

**No.** `@sisal/orm` re-exports the entire core surface, and every previous
subpath keeps working as a compatibility re-export:

| Existing import     | Status                                  |
| ------------------- | --------------------------------------- |
| `@sisal/orm`        | unchanged — re-exports all of core      |
| `@sisal/orm/core`   | unchanged — core surface + the ORM tier |
| `@sisal/orm/schema` | re-exports `@sisal/core/schema`         |
| `@sisal/orm/error`  | re-exports the core error primitives    |
| `@sisal/orm/logger` | re-exports the core `Logger` contract   |

Adapters (`@sisal/pg`, `@sisal/neon`, `@sisal/sqlite`, `@sisal/libsql`,
`@sisal/mysql`) are unaffected.

## When to import `@sisal/core` directly

Prefer `@sisal/core` when the code does **not** need the ORM tier — it is the
compile target for downstream packages (`@sisal/etl`, `@sisal/analytics`) and
for anything that only renders SQL, defines schema, or queries capabilities:

- `defineTable`, `columns`, `createSchemaSnapshot`, constraint helpers
- the `sql` tag, `renderSql`, `dialectSql`, prepared-plan primitives
- operators and aggregates (`eq`, `and`, `count`, `filter`, date helpers, …)
- the capability registry (`DIALECT_CAPABILITIES`, `capabilitySupported`,
  `capabilityGuard`, `CAPABILITY_TARGETS`) and `dialectGuard`
- `SisalError`/`OrmError`, `Logger`, and the snapshot contract
  (`@sisal/core/schema`)

`@sisal/migrate` follows this rule and now depends on `@sisal/core` only.

## What moved where

| Module                                       | New home                    |
| -------------------------------------------- | --------------------------- |
| `error`, `logger`, `schema`                  | `packages/core/` (root)     |
| `errors`, `sql`, `capabilities`, `operators` | `packages/core/`            |
| `columns`, `temporal`, `table`               | `packages/core/`            |
| `builders`, `database`, `functions`,         | `packages/orm/core/` (stay) |
| `relations`                                  |                             |

## The `unstable-internal` seam

`@sisal/core/unstable-internal` exposes the builder plumbing `@sisal/orm`'s
query-builder tier needs (condition/metadata internals, prepared-plan filling,
`QUERY_BUILDER_BRAND`, temporal decode helpers). It is **not** part of the
documented compile target and carries no stability commitment — do not build on
it. Downstream packages use the package root.
