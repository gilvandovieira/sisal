<p align="center">
  <img src="./assets/sisal-banner.png" alt="Sisal - a Deno-first database toolkit published to JSR: typed schemas, planned migrations, and small database adapters" width="900">
</p>

# Sisal

Sisal is a Deno-first database toolkit, published to JSR, for typed schemas,
safe SQL, query builders, migration planning, and small adapter packages.

The core idea is simple: keep schema and migration logic portable, then attach
database-specific behavior at explicit adapter boundaries. `@sisal/orm` is
driverless. `@sisal/migrate` is adapter-neutral. PostgreSQL, Neon, SQLite, and
libSQL/Turso live in their own packages.

Every package is published to JSR, and the `@sisal/orm` + `@sisal/migrate` core
is pure JSR. npm appears only at explicit boundaries: the libSQL adapter imports
`npm:@libsql/client`, the Neon driver pulls a few transitive npm dependencies,
and the benchmarks compare against `npm:drizzle-orm`.

## Installing

With Deno and JSR, either import packages directly:

```ts
import { columns, defineTable } from "jsr:@sisal/orm@0.1";
import { connect } from "jsr:@sisal/sqlite@0.1";
```

Or add an import map in `deno.json`:

```json
{
  "imports": {
    "@sisal/orm": "jsr:@sisal/orm@0.1",
    "@sisal/migrate": "jsr:@sisal/migrate@0.1",
    "@sisal/migrate/cli": "jsr:@sisal/migrate@0.1/cli",
    "@sisal/migrate/workflow": "jsr:@sisal/migrate@0.1/workflow",
    "@sisal/pg": "jsr:@sisal/pg@0.1",
    "@sisal/neon": "jsr:@sisal/neon@0.1",
    "@sisal/sqlite": "jsr:@sisal/sqlite@0.1",
    "@sisal/libsql": "jsr:@sisal/libsql@0.1"
  }
}
```

Adapter subpaths are available when you want narrower boundaries:

```ts
import { createPgOrmDriver } from "@sisal/pg/orm";
import { createPgMigrator } from "@sisal/pg/migrate";
import { generatePostgresUpStatements } from "@sisal/pg/ddl";
```

## What You Get

- Typed table definitions with inferred insert and select shapes.
- A parameterized `sql` template plus `raw`, `identifier`, `joinSql`, and
  dialect-aware rendering.
- Fluent `select`, `insert`, `update`, and `delete` builders.
- Filter helpers such as `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`,
  `between`, `inArray`, `isNull`, `and`, `or`, and `not`.
- Aggregates and ordering helpers: `count`, `sum`, `avg`, `min`, `max`, `asc`,
  and `desc`.
- Joins, `distinct`, `groupBy`, `having`, `limit`, `offset`, `returning`, and
  upsert helpers.
- Drizzle-style `relations()` metadata with `db.query.table.findMany()` and
  `findFirst()` when you create a schema-aware database facade.
- Stable schema snapshots, snapshot diffing, and additive DDL generation.
- Migration definitions, checksums, planning, rollback support in adapter
  migrators, file workflow helpers, drift checks, and a CLI.
- Adapter packages for PostgreSQL, Neon serverless PostgreSQL, SQLite, and
  libSQL/Turso.
- Structured `SisalError`, `OrmError`, and `MigrationError` classes plus a tiny
  logger interface.

## Packages

| Package          | Purpose                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `@sisal/orm`     | Driverless schema definitions, typed SQL, query builders, snapshots, errors, and logger contracts.                      |
| `@sisal/migrate` | Adapter-neutral migrations, checksums, planning, history stores, workflow helpers, drift checks, and CLI runner.        |
| `@sisal/pg`      | PostgreSQL ORM driver, pool boundary, migration history, migrator, and PostgreSQL DDL generation.                       |
| `@sisal/neon`    | Neon serverless PostgreSQL adapter using `@neon/serverless`, with PostgreSQL-compatible ORM, migrator, and DDL exports. |
| `@sisal/sqlite`  | SQLite ORM driver, migration history, migrator, and SQLite DDL generation.                                              |
| `@sisal/libsql`  | libSQL/Turso ORM driver, migration history, migrator, and SQLite-compatible DDL aliases.                                |

Repository layout:

```text
packages/orm       Driverless ORM, schema, SQL, snapshots
packages/migrate   Adapter-neutral migration planning and running
packages/pg        PostgreSQL ORM and migration adapter boundary
packages/neon      Neon serverless PostgreSQL adapter boundary
packages/sqlite    SQLite ORM and migration adapter boundary
packages/libsql    libSQL/Turso ORM and migration adapter boundary

examples/basic-postgres
examples/basic-sqlite
examples/basic-libsql
benchmarks
docs
```

The dependency direction is strict. Adapters may depend on `@sisal/orm` and
`@sisal/migrate`; the ORM never imports PostgreSQL, Neon, SQLite, libSQL, Pequi
Logger, or any legacy package namespace.

## Quick Start

This example defines a SQLite schema, generates additive DDL from the schema
snapshot, applies it, inserts data, and queries it back.

```ts
import { columns, createSchemaSnapshot, defineTable, eq } from "@sisal/orm";
import { connect, generateSqliteUpStatements } from "@sisal/sqlite";

const notes = defineTable("notes", {
  id: columns.text().primaryKey(),
  title: columns.text().notNull(),
  body: columns.text().optional(),
  archived: columns.boolean().default(false),
});

const snapshot = createSchemaSnapshot({
  dialect: "sqlite",
  tables: [notes],
});

const db = await connect({ path: ":memory:" });

try {
  const { statements, destructive } = generateSqliteUpStatements(snapshot);

  if (destructive.length > 0) {
    throw new Error("Refusing to apply destructive generated changes.");
  }

  for (const statement of statements) {
    await db.execute(statement);
  }

  await db.insert(notes).values({
    id: crypto.randomUUID(),
    title: "First note",
  }).execute();

  const rows = await db.select().from(notes)
    .where(eq(notes.columns.archived, false))
    .execute();

  console.log(rows);
} finally {
  await db.close();
}
```

SQLite uses `jsr:@db/sqlite`, so real SQLite execution needs Deno FFI
permission:

```sh
deno run --allow-ffi --allow-read --allow-write app.ts
```

## Defining Schemas

Tables are immutable metadata objects. Columns are nullable by default, matching
SQL. Nullable means the value may be `null`; use `.optional()` or `.default()`
when a field may be omitted from insert objects. Use `.notNull()` when a column
is required. `.primaryKey()` implies `.notNull()`.

```ts
import {
  columns,
  defineTable,
  type InferInsert,
  type InferSelect,
} from "@sisal/orm";

const users = defineTable("users", {
  id: columns.uuid().primaryKey(),
  email: columns.text().notNull().unique(),
  name: columns.text().optional(),
  age: columns.integer().optional(),
  orgId: columns.integer().optional(),
  active: columns.boolean().default(true),
  profile: columns.jsonb<{ bio?: string }>().optional(),
  createdAt: columns.timestamp({ withTimezone: true }).notNull(),
});

type User = InferSelect<typeof users>;
type NewUser = InferInsert<typeof users>;
```

Column builders include:

```ts
columns.text();
columns.varchar(255);
columns.char(2);
columns.integer();
columns.smallint();
columns.bigint(); // string-typed to preserve 64-bit precision
columns.serial(); // optional on insert
columns.bigserial(); // string-typed, optional on insert
columns.numeric(10, 2); // string-typed to preserve precision
columns.decimal(10, 2);
columns.real();
columns.doublePrecision();
columns.boolean();
columns.json<{ ok: boolean }>();
columns.jsonb<{ tags: string[] }>();
columns.date();
columns.timestamp();
columns.timestamp({ withTimezone: true });
columns.uuid();
columns.bytea(); // Postgres bytea, SQLite/libSQL BLOB
```

Column modifiers:

```ts
const posts = defineTable("posts", {
  id: columns.serial().primaryKey(),
  slug: columns.text().named("post_slug").notNull().unique(),
  authorId: columns.uuid().notNull().references("users", "id"),
  tags: columns.text().array(),
  published: columns.boolean().default(false),
  updatedAt: columns.timestamp({ withTimezone: true })
    .$onUpdate(() => new Date()),
});
```

Schemas are supported for dialects that use them:

```ts
const auditEvents = defineTable(
  "events",
  {
    id: columns.uuid().primaryKey(),
    action: columns.text().notNull(),
  },
  { schema: "audit" },
);
```

## Typed SQL

The `sql` template stores interpolated values as parameters. Rendering is
dialect-aware, so PostgreSQL gets `$1`, `$2`, while SQLite-style dialects get
`?`.

```ts
import { identifier, raw, renderSql, sql } from "@sisal/orm";

const query = sql`
  select *
  from ${identifier("public.users")}
  where email = ${"ada@example.com"}
    and created_at <= ${new Date()}
  order by ${raw("created_at desc")}
`;

const rendered = renderSql(query, { dialect: "postgres" });
// rendered.text includes placeholders; rendered.params contains the values.
```

Use `raw()` only for trusted SQL snippets. Values should usually be interpolated
with `${value}` so Sisal can parameterize them.

## Query Builder

Every adapter-backed database facade exposes the same fluent builders.

```ts
import { and, desc, eq, gt, isNotNull } from "@sisal/orm";

const adults = await db.select({
  id: users.columns.id,
  email: users.columns.email,
  age: users.columns.age,
}).from(users)
  .where(and(gt(users.columns.age, 17), isNotNull(users.columns.email)))
  .orderBy(desc(users.columns.age))
  .limit(20)
  .offset(0)
  .execute();

const alice = await db.insert(users).values({
  id: crypto.randomUUID(),
  email: "alice@example.com",
  active: true,
  createdAt: new Date(),
}).returning({
  id: users.columns.id,
  email: users.columns.email,
}).execute();

await db.update(users)
  .set({ active: false })
  .where(eq(users.columns.email, "alice@example.com"))
  .execute();

await db.delete(users)
  .where(eq(users.columns.email, "alice@example.com"))
  .execute();
```

Updates and deletes are intentionally guarded: call `.where(...)` or
`.unsafeAllowAllRows()` before executing them.

## Filters, Joins, And Aggregates

Sisal ships small helpers that render as SQL conditions or expressions.

```ts
import {
  avg,
  count,
  eq,
  gt,
  inArray,
  isNotNull,
  max,
  min,
  sum,
} from "@sisal/orm";

const orgs = defineTable("orgs", {
  id: columns.integer().primaryKey(),
  name: columns.text().notNull(),
});

const usersByOrg = await db.select({
  orgId: users.columns.orgId,
  count: count(),
  averageAge: avg(users.columns.age),
  totalAge: sum(users.columns.age),
  youngest: min(users.columns.age),
  oldest: max(users.columns.age),
}).from(users)
  .where(isNotNull(users.columns.orgId))
  .groupBy(users.columns.orgId)
  .having(gt(count(), 1))
  .execute();

const joined = await db.select({
  email: users.columns.email,
  organization: orgs.columns.name,
}).from(users)
  .innerJoin(orgs, eq(orgs.columns.id, users.columns.orgId))
  .where(inArray(users.columns.id, [1, 2, 3]))
  .execute();
```

Supported join builders are `innerJoin`, `leftJoin`, `rightJoin`, and
`fullJoin`. `select().distinct()` emits `SELECT DISTINCT`.

## Inserts And Upserts

`insert().values()` accepts one row or many rows. `returning()` returns full
rows or a projection when the dialect supports `RETURNING`.

```ts
await db.insert(orgs).values([
  { id: 1, name: "Acme" },
  { id: 2, name: "Globex" },
]).execute();

await db.insert(orgs).values({ id: 1, name: "Duplicate" })
  .onConflictDoNothing({ target: orgs.columns.id })
  .execute();

await db.insert(orgs).values({ id: 1, name: "Acme, Inc." })
  .onConflictDoUpdate({
    target: orgs.columns.id,
    set: { name: "Acme, Inc." },
  })
  .execute();
```

## Transactions

Transactions use the same database facade inside the callback. Throwing from the
callback rolls back.

```ts
await db.transaction(async (tx) => {
  await tx.insert(orgs).values({ id: 10, name: "Tx Org" }).execute();
  await tx.insert(users).values({
    id: crypto.randomUUID(),
    email: "tx@example.com",
    orgId: 10,
    active: true,
    createdAt: new Date(),
  }).execute();
});
```

## Relational Queries

`relations()` describes one-to-one and one-to-many relationships. To enable
`db.query.<table>`, create the database facade with a schema map and relations.
The adapter `connect()` helpers are optimized for the common builder API; use
`createDatabase()` plus an adapter driver when you want relation helpers.

```ts
import {
  asc,
  columns,
  createDatabase,
  defineTable,
  relations,
} from "@sisal/orm";
import { createPgOrmDriver, POSTGRES_DIALECT } from "@sisal/pg/orm";

const users = defineTable("users", {
  id: columns.integer().primaryKey(),
  name: columns.text().notNull(),
});

const posts = defineTable("posts", {
  id: columns.integer().primaryKey(),
  userId: columns.integer().notNull().references("users", "id"),
  title: columns.text().notNull(),
});

const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
}));

const postsRelations = relations(posts, ({ one }) => ({
  author: one(users, {
    fields: [posts.columns.userId],
    references: [users.columns.id],
  }),
}));

const db = createDatabase({
  dialect: POSTGRES_DIALECT,
  driver: createPgOrmDriver({ url: Deno.env.get("DATABASE_URL") }),
  schema: { users, posts },
  relations: [usersRelations, postsRelations] as const,
});

const result = await db.query.users.findMany({
  columns: { name: true },
  with: {
    posts: {
      columns: { title: true },
      orderBy: asc(posts.columns.id),
    },
  },
  orderBy: asc(users.columns.id),
});
```

## Schema Snapshots And DDL

Snapshots are serializable descriptions of the schema. Adapter DDL helpers turn
snapshot diffs into non-destructive `up` statements.

```ts
import { createSchemaSnapshot } from "@sisal/orm";
import { generatePostgresUpStatements } from "@sisal/pg/ddl";

const previous = createSchemaSnapshot({
  dialect: "postgres",
  tables: [users],
});

const next = createSchemaSnapshot({
  dialect: "postgres",
  tables: [users, posts],
});

const { statements, destructive } = generatePostgresUpStatements(
  next,
  previous,
);
```

Generated statements include additive changes such as `CREATE TABLE` and
`ALTER TABLE ADD COLUMN`. Destructive changes such as dropping tables, dropping
columns, or changing column types are returned in `destructive` and are never
silently emitted as ordinary generated SQL.

SQLite and libSQL use SQLite affinity mapping:

```ts
import { generateSqliteUpStatements } from "@sisal/sqlite/ddl";
import { generateLibsqlUpStatements } from "@sisal/libsql/ddl";
```

PostgreSQL and Neon use PostgreSQL DDL:

```ts
import { generatePostgresUpStatements } from "@sisal/pg/ddl";
import {
  generatePostgresUpStatements as generateNeonUpStatements,
} from "@sisal/neon/ddl";
```

## Migrations In Code

The core migration package is adapter-neutral. It can run SQL migrations,
programmatic migrations, in-memory stores for tests, and real adapter-backed
history stores.

```ts
import {
  createMigrator,
  defineSqlMigration,
  memoryMigrationStore,
  noopMigrationDriver,
} from "@sisal/migrate";

const migration = defineSqlMigration({
  id: "0001_create_users",
  up: "create table users (id text primary key, email text not null)",
  down: "drop table users",
});

const migrator = createMigrator({
  migrations: [migration],
  store: memoryMigrationStore(),
  driver: noopMigrationDriver(),
});

const plan = await migrator.plan();
const result = await migrator.up();
```

Adapter migrators wire the same planning and checksum logic to a real database
history table.

```ts
import { createPgMigrator } from "@sisal/pg/migrate";

const migrator = await createPgMigrator({
  url: Deno.env.get("DATABASE_URL"),
  historyTable: "sisal_migrations",
});

try {
  await migrator.migrate({ migrations: [migration] });
  await migrator.rollback({ migrations: [migration], steps: 1 });
} finally {
  await migrator.close();
}
```

Equivalent helpers exist for `@sisal/sqlite/migrate`, `@sisal/libsql/migrate`,
and `@sisal/neon/migrate`.

## CLI

`@sisal/migrate/cli` wraps the snapshot workflow into a `sisal` command. The CLI
can scaffold a config, generate additive SQL migrations, apply pending
migrations, report status, and fail CI when drift is present.

In this repository, use the local task:

```sh
deno task sisal --help
deno task sisal init --target sqlite
deno task sisal generate create users
deno task sisal migrate
deno task sisal status
deno task sisal drift
```

From JSR, run the published CLI directly:

```sh
deno run --allow-read --allow-write --allow-env --allow-net --allow-ffi \
  jsr:@sisal/migrate/cli --help
```

Use the same permission set for commands that read config, write migration
files, inspect environment variables, or open databases:

```sh
deno run --allow-read --allow-write --allow-env --allow-net --allow-ffi \
  jsr:@sisal/migrate/cli init --target postgres

deno run --allow-read --allow-write --allow-env --allow-net --allow-ffi \
  jsr:@sisal/migrate/cli generate create users

deno run --allow-read --allow-write --allow-env --allow-net --allow-ffi \
  jsr:@sisal/migrate/cli migrate
```

### CLI Targets

`sisal init` supports these targets:

| Target     | Aliases            | Configured dialect | Connection fields                                                                                                           |
| ---------- | ------------------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `postgres` | `pg`, `postgresql` | `postgres`         | `databaseUrl` or `DATABASE_URL`                                                                                             |
| `sqlite`   | none               | `sqlite`           | `databasePath`                                                                                                              |
| `libsql`   | `turso`            | `sqlite`           | `databaseUrl`, `databaseAuthToken`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `LIBSQL_DATABASE_URL`, or `LIBSQL_AUTH_TOKEN` |

Neon is available through `@sisal/neon`. The CLI's default `postgres` path loads
`@sisal/pg`.

### CLI Config

The CLI loads `sisal.migrate.ts` by default. Export `default` or `config` from
`defineConfig(...)`.

```ts
import { columns, createSchemaSnapshot, defineTable } from "@sisal/orm";
import { defineConfig } from "@sisal/migrate/workflow";

const users = defineTable("users", {
  id: columns.text().primaryKey(),
  email: columns.text().notNull().unique(),
  name: columns.text(),
});

const snapshot = createSchemaSnapshot({
  dialect: "sqlite",
  tables: [users],
});

export default defineConfig({
  dir: "migrations",
  dialect: "sqlite",
  snapshot,
  databasePath: Deno.env.get("SQLITE_PATH") ?? "app.db",
});
```

PostgreSQL config:

```ts
export default defineConfig({
  dir: "migrations",
  dialect: "postgres",
  snapshot,
  databaseUrl: Deno.env.get("DATABASE_URL"),
  historyTable: "sisal_migrations",
});
```

Turso/libSQL config:

```ts
export default defineConfig({
  dir: "migrations",
  dialect: "sqlite",
  snapshot,
  databaseUrl: Deno.env.get("TURSO_DATABASE_URL") ?? "file:app.db",
  databaseAuthToken: Deno.env.get("TURSO_AUTH_TOKEN"),
});
```

### CLI Workflow

1. Scaffold the config and migrations directory.

```sh
deno task sisal init --target sqlite --dir migrations
```

This creates `sisal.migrate.ts` and `migrations/`. Edit the config so `snapshot`
is built from your application tables.

2. Generate an additive migration.

```sh
deno task sisal generate create users
```

The command diffs the newest `*.snapshot.json` in the migrations directory
against `config.snapshot`, then writes files like:

```text
migrations/0001_create_users.sql
migrations/0001_create_users.snapshot.json
```

If there are no changes, no migration is written unless `--allow-empty` is set.
If destructive changes are detected, the CLI prints them and refuses to write a
snapshot that the generated SQL cannot reproduce.

3. Preview or apply pending migrations.

```sh
deno task sisal migrate --dry-run
deno task sisal migrate
deno task sisal migrate --steps 1
```

Use `--allow-dirty` only when you intentionally want to run despite checksum
mismatches.

4. Inspect status and drift.

```sh
deno task sisal status
deno task sisal drift
```

`status` prints migration file counts, database plan information when a database
is configured, and drift findings. `drift` exits with code `1` when the current
snapshot differs from the latest generated snapshot, migrations are pending, or
a SQL file is missing its paired snapshot file.

Useful overrides:

```sh
deno task sisal status --config ./db/sisal.migrate.ts
deno task sisal migrate --database-url "$DATABASE_URL"
deno task sisal migrate --database-path ./dev.sqlite
deno task sisal migrate --history-table app_migrations
```

## Adapter Examples

PostgreSQL:

```ts
import { connect } from "@sisal/pg";

const db = await connect({
  url: Deno.env.get("DATABASE_URL"),
});
```

Neon:

```ts
import { connect } from "@sisal/neon";

const db = await connect({
  url: Deno.env.get("DATABASE_URL"),
});
```

SQLite:

```ts
import { connect } from "@sisal/sqlite";

const db = await connect({
  path: "app.db",
});
```

libSQL/Turso:

```ts
import { connect } from "@sisal/libsql";

const db = await connect({
  url: Deno.env.get("TURSO_DATABASE_URL") ?? "file:app.db",
  authToken: Deno.env.get("TURSO_AUTH_TOKEN"),
});
```

All adapter database facades expose `query`, `execute`, `select`, `insert`,
`update`, `delete`, `transaction`, and `close`.

## Dialect Notes

- PostgreSQL supports native arrays, `json`/`jsonb`, `bytea`, schemas,
  PostgreSQL placeholders, and PostgreSQL DDL.
- Neon reuses the PostgreSQL dialect and DDL helpers while executing through
  `@neon/serverless`.
- SQLite maps higher-level types onto SQLite affinities: booleans use `INTEGER`,
  JSON and arrays are stored as JSON text, dates/UUIDs use `TEXT`, and binary
  data uses `BLOB`.
- libSQL/Turso follows the SQLite dialect and exposes SQLite-compatible DDL
  helpers.

## Logging And Errors

Sisal accepts a small generic logger interface:

```ts
interface Logger {
  debug(record: Record<string, unknown>, message: string): void;
  info(record: Record<string, unknown>, message: string): void;
  warn(record: Record<string, unknown>, message: string): void;
  error(record: Record<string, unknown>, message: string): void;
}
```

Pequi Logger fits this shape, but it is not a dependency of `@sisal/orm`.

Errors are structured:

```ts
import { MigrationError } from "@sisal/migrate";
import { OrmError, SisalError } from "@sisal/orm";

try {
  await db.execute("select * from missing_table");
} catch (error) {
  if (error instanceof SisalError) {
    console.error(error.code, error.severity, error.details);
  }
}
```

## Development

Install the repository hook once:

```sh
deno task hooks:install
```

Common checks:

```sh
deno task fmt
deno task fmt:check
deno lint
deno task check
deno task test
deno task docs:check
deno task publish:dry-run
```

Publishing is handled by `.github/workflows/publish.yml`. Manual dispatch runs a
dry-run by default; setting `dry_run` to `false` publishes from `main`. Pushing
a release tag like `v0.2.0` publishes automatically after the workflow checks
that every package manifest is also at `0.2.0`. JSR trusted publishing uses
GitHub Actions OIDC, so each `@sisal/*` package must be connected to this GitHub
repository in JSR package settings.

Integration suites are opt-in because they use real database drivers or
services:

```sh
DATABASE_URL=postgres://... deno test -A integration/pg_features_test.ts

SISAL_SQLITE_IT=1 deno test --allow-ffi --allow-read --allow-write \
  --allow-env --allow-net integration/sqlite_features_test.ts

SISAL_LIBSQL_IT=1 deno test -A integration/libsql_features_test.ts
```

The separate `.github/workflows/integration.yml` workflow runs these suites on a
weekly schedule and by manual dispatch. It covers PostgreSQL 16/17/18 through
Docker, Neon through the bundled local WebSocket proxy, and local SQLite/libSQL
execution.

The main CI workflow uses Deno `v2.8.3`, installs with `--frozen`, checks
formatting, linting, docs coverage, workspace type-checking, package tests, a
workspace publish dry-run, and publish dry-runs for each workspace package.

See [migration notes](./docs/migration-notes.md) for transition guidance.
