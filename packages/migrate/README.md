# @sisal/migrate

Adapter-neutral migration planning and running for Sisal.

`@sisal/migrate` defines migration records, checksums, plans, in-memory history
storage, file workflow helpers, schema diff classification, and a generic
migrator. It depends on `@sisal/core` for schema snapshot types and helpers, but
it does not depend on PostgreSQL or SQLite drivers.

> **Install** — JSR first, npm supported with registry-specific scopes:
>
> - Deno / JSR (`@sisal/*`): `deno add jsr:@sisal/migrate`
> - Node 24+ / npm (`@sisaljs/*`): `npm i @sisaljs/migrate`
>
> Examples use the JSR import (`@sisal/migrate`); on npm import from
> `@sisaljs/migrate`. On npm the package ships a `sisal` bin — run it with
> `npx sisal <command>`.

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

`@sisal/migrate/cli` provides the `sisal` command runner. On Node (npm), use the
bundled `sisal` bin; on Deno, run the JSR entry directly:

```sh
# Node (npm) — the @sisaljs/migrate bin:
npx sisal generate initial
npx sisal migrate
npx sisal status
npx sisal drift

# Deno (JSR) — least-privilege permissions per command:
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
`databasePath`; PostgreSQL uses `databaseUrl`; Turso/libSQL uses
`dialect: "sqlite"` with a libSQL `databaseUrl` and optional
`databaseAuthToken`. **MySQL/MariaDB** uses `dialect: "mysql"` with
`databaseUrl` (scaffold it with `sisal init --target mysql`). **Neon**
(serverless PostgreSQL) uses `dialect: "postgres"` with `provider: "neon"`
(scaffold it with `sisal init --neon`); `sisal migrate` then applies through
`@sisal/neon` over HTTP, one statement per call.

`sisal.migrate.ts` is trusted local executable code. Run the CLI with the least
permissions your target needs:

```sh
# generate/drift without a database connection
deno run --allow-read=. --allow-write=./migrations jsr:@sisal/migrate/cli generate initial

# migrate against one configured host and one env-carried DSN
deno run --allow-read=. --allow-env=DATABASE_URL --allow-net=db.example.com:5432 \
  jsr:@sisal/migrate/cli migrate
```

Migration SQL files are also developer-authored trusted input. The splitter is
tested for comments, strings, and dollar-quoted bodies, but it is not a sandbox
for untrusted SQL.

## Serverless / single-statement apply

`splitSqlStatements(sql)` splits a `.sql` script into individual statements on
top-level `;`, ignoring semicolons inside strings, quoted identifiers, comments,
and dollar-quoted (`$$ … $$`, `$tag$ … $tag$`) bodies. Pair it with the
migrator's `splitStatements` option (also `createPgMigrator` /
`createNeonMigrator`) to apply a multi-statement migration one statement per
`driver.execute(...)` call — required for transports that accept only one
statement per query, such as Neon's HTTP driver (where it defaults to on).
