# @sisal/core

Sisal's driverless **compile target**: schema primitives (`defineTable`,
`columns`, schema snapshots), the fragment SQL IR (`sql` tag, `Sql` chunks),
expression operators and aggregates, the declarative dialect **capability
registry** (`DIALECT_CAPABILITIES`, `capabilitySupported`), and the
dialect-aware renderer (`renderSql`) with typed `ORM_DIALECT_UNSUPPORTED`
guards.

Extracted from `@sisal/orm`'s lower tier so that downstream packages
(`@sisal/etl`, `@sisal/analytics`) can compile SQL into Sisal without depending
on the OLTP ORM. The fluent query builders, `Database` facade, relations, and
typed function caller remain in [`@sisal/orm`](https://jsr.io/@sisal/orm), which
re-exports this package.

- `@sisal/core` — the documented public surface.
- `@sisal/core/schema` — the serializable schema-snapshot contract.
- `@sisal/core/unstable-internal` — builder plumbing for `@sisal/orm`; not a
  stable API.

The compile-target contract — the versioned `Sql`/`SqlChunk` IR
(`SQL_IR_VERSION`), what is public vs internal, the compatibility policy, and
the statement-assembly seam (`assembleSelect`/`assembleInsertFromSelect`) — is
documented in
[docs/core-ir.md](https://github.com/gilvandovieira/sisal/blob/main/docs/core-ir.md).

Security posture:

- Runtime values should enter SQL through `sql` fragments so they render as
  bound parameters.
- Identifiers are validated and quoted by the schema/identifier helpers.
- `raw(text)`, DDL default expressions, generated expressions, and
  `customType(...).dialectType` are trusted-code escape hatches. Do not pass
  user-controlled strings to them.
- Dialect-specific constructs go through the capability registry and fail with
  typed `ORM_DIALECT_UNSUPPORTED` errors instead of silently degrading.
