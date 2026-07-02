---
title: Migration Notes
---

# Migration Notes

Sisal replaces the earlier ORM and migration package direction with a focused
database toolkit.

## Package Names

| Earlier package area                | Sisal package    |
| ----------------------------------- | ---------------- |
| Core ORM/schema pieces              | `@sisal/orm`     |
| Core migration pieces               | `@sisal/migrate` |
| PostgreSQL ORM and migration pieces | `@sisal/pg`      |
| Neon serverless PostgreSQL pieces   | `@sisal/neon`    |
| SQLite ORM and migration pieces     | `@sisal/sqlite`  |
| libSQL/Turso ORM and migration      | `@sisal/libsql`  |

## Important Boundary Changes

- `@sisal/orm` is driverless.
- PostgreSQL code lives in `@sisal/pg`.
- SQLite code lives in `@sisal/sqlite`.
- `@sisal/migrate` consumes schema snapshots from `@sisal/orm` and owns generic
  migration planning/running.
- Sisal uses its own small structured error and logger contracts.
- Sisal packages do not depend on the former package namespace.

## Logging

Legacy logging imports should be removed. Pass any logger that matches Sisal's
generic logger interface. Pequi Logger is recommended for applications that
already use it, but it is not required by `@sisal/orm`.

For Hibernate-style verbosity controls, keep `logger` for compatibility or pass
`logging: { logger, level, categories, sql }` to ORM and migrator facades.
`debug` emits SQL/timing categories; `trace` additionally emits redacted
bind-parameter summaries. The migration CLI accepts `--log-level`, `--quiet`,
and repeatable `-v`/`--verbose`, and `sisal.migrate.ts` may define default
`logging` settings.

## Migration Approach

Start by moving table definitions to `@sisal/orm`, then generate or compare
schema snapshots through `createSchemaSnapshot`. Use `@sisal/migrate` for
generic migration planning and `@sisal/pg` or `@sisal/sqlite` for
database-specific execution and DDL.
