---
title: Sisal Docs
---

# Sisal

Sisal is a focused Deno-first, JSR-native database toolkit for typed schemas,
planned migrations, and small PostgreSQL and SQLite adapters.

## Documentation

| Page                                    | Purpose                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| [API Reference](./api.md)               | Public API surface across `@sisal/orm`, `@sisal/migrate`, `@sisal/pg`, and `@sisal/sqlite`. |
| [Migration Notes](./migration-notes.md) | Package rename and boundary guidance for moving to Sisal.                                   |
| [Drizzle Parity](./drizzle-parity.md)   | Compatibility map against Drizzle ORM and the intentional Sisal divergences.                |

## Packages

```text
packages/orm       Driverless ORM, schema, SQL, snapshots
packages/migrate   Adapter-neutral migration planning and running
packages/pg        PostgreSQL ORM and migration adapter boundary
packages/sqlite    SQLite ORM and migration adapter boundary
```
