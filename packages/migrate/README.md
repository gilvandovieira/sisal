# @sisal/migrate

Adapter-neutral migration planning and running for Sisal.

`@sisal/migrate` defines migration records, checksums, plans, in-memory history
storage, file workflow helpers, schema diff classification, and a generic
migrator. It may depend on `@sisal/orm` for schema snapshot types and helpers,
but it does not depend on PostgreSQL or SQLite drivers.

```ts
import {
  createMigrator,
  defineSqlMigration,
  memoryMigrationStore,
  noopMigrationDriver,
} from "@sisal/migrate";

const migrator = createMigrator({
  migrations: [
    defineSqlMigration({
      id: "0001_init",
      up: "create table users (id text primary key)",
      down: "drop table users",
    }),
  ],
  store: memoryMigrationStore(),
  driver: noopMigrationDriver(),
});

await migrator.up();
```

Use `@sisal/pg` or `@sisal/sqlite` for database-specific history stores,
execution, and DDL generation.

## CLI

`@sisal/migrate/cli` provides the `sisal` command runner:

```sh
deno run --allow-read --allow-write --allow-env --allow-net --allow-ffi \
  jsr:@sisal/migrate/cli generate initial
deno run --allow-read --allow-write --allow-env --allow-net --allow-ffi \
  jsr:@sisal/migrate/cli migrate
deno run --allow-read --allow-env --allow-net --allow-ffi \
  jsr:@sisal/migrate/cli status
deno run --allow-read --allow-env --allow-net --allow-ffi \
  jsr:@sisal/migrate/cli drift
```

By default it loads `sisal.migrate.ts`, which should export `default` or
`config` from `defineConfig({ dir, dialect, snapshot, ... })`. SQLite uses
`databasePath`; PostgreSQL uses `databaseUrl`.
