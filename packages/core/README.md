# @sisal/core

Sisal's driverless **compile target**: schema primitives (`defineTable`,
`columns`, schema snapshots), the fragment SQL IR (`sql` tag, `Sql` chunks),
expression operators and aggregates, the declarative dialect **capability
registry** (`DIALECT_CAPABILITIES`, `capabilitySupported`), and the
dialect-aware renderer (`renderSql`) with typed `ORM_DIALECT_UNSUPPORTED`
guards.

Extracted from `@sisal/orm`'s lower tier in v0.8 so that downstream packages
(`@sisal/etl`, `@sisal/analytics`) can compile SQL into Sisal without depending
on the OLTP ORM. The fluent query builders, `Database` facade, relations, and
typed function caller remain in [`@sisal/orm`](https://jsr.io/@sisal/orm), which
re-exports this package — existing `@sisal/orm` users need no changes.

- `@sisal/core` — the documented public surface.
- `@sisal/core/schema` — the serializable schema-snapshot contract.
- `@sisal/core/unstable-internal` — builder plumbing for `@sisal/orm`; not a
  stable API.

The compile-target contract — the versioned `Sql`/`SqlChunk` IR
(`SQL_IR_VERSION`), what is public vs internal, the compatibility policy, and
the statement-assembly seam (`assembleSelect`/`assembleInsertFromSelect`) — is
documented in
[docs/core-ir.md](https://github.com/gilvandovieira/sisal/blob/main/docs/core-ir.md).
