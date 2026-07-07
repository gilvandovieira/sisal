<p align="center">
  <img src="./assets/brand/og-image.png" alt="Sisal — a JSR-first database toolkit with npm support" width="900">
</p>

# Sisal

Pronunciation: **Sisal** is read in Brazilian Portuguese as /siˈzaw/.

> [!WARNING]
> Sisal is a collection of preview packages. We think the core APIs, migration
> workflow, and adapters are stable enough for serious investigation,
> prototypes, and non-production trials, but we do not recommend production
> deployments yet. APIs, schema snapshot formats, generated DDL, migration
> workflows, and adapter behavior may still change before 1.0.

Sisal is a JSR-first, Deno-native collection of **ORM and query-builder
packages**, also published to npm for Node.js 24+ as of v0.12 — typed schemas,
safe SQL builders, schema snapshots, migration planning, and explicit database
adapters — with **lightweight ETL and analytics capabilities** growing on the
same driverless core.

The core stays portable: `@sisal/orm` is driverless and `@sisal/migrate` is
adapter-neutral. PostgreSQL, Neon, SQLite, libSQL/Turso, and MySQL/MariaDB
behavior lives in adapter packages, where database drivers and runtime-specific
dependency edges belong.

Every Sisal package is published at the same version to both registries with a
registry-specific scope: JSR uses `@sisal/*`, while npm uses `@sisaljs/*`. For
example, the ORM package is `jsr:@sisal/orm` on JSR and `@sisaljs/orm` on npm.
The API is shared; the install command, import scope, and adapter driver peer
dependencies are the runtime-specific parts. The core packages stay driverless
on both targets. Adapter packages own runtime-specific driver edges: `@sisal/pg`
/ `@sisaljs/pg` can use `postgres` or `jsr:@db/postgres`; SQLite uses
`jsr:@db/sqlite` on Deno and `node:sqlite` on Node; libSQL/Turso uses
`@libsql/client`; Neon uses `@neondatabase/serverless` on npm; MySQL/MariaDB
uses `mysql2` by default with a lazy MariaDB connector opt-in.

Sisal is inspired by useful vocabulary from the TypeScript database ecosystem,
including Drizzle's fluent SQL-builder style, but it is not a compatibility
layer and keeps its own driverless core, snapshot workflow, and adapter split.

> [!NOTE]
> **Scope — advanced queries first, ETL and analytics as an entry point.** Sisal
> is first an ORM and serious SQL query builder: it is meant to cover typed
> application queries as well as more advanced SQL shapes such as CTEs,
> subqueries, window functions, aggregates, set operations, keyset pagination,
> and safe raw fragments. Its ETL and analytics layers are more deliberately
> modest: a typed rollup job with a single-run runner, and a typed query API
> over the shapes it produces — all pushed down into your existing database, no
> extra engine. They are meant to let a project already using Sisal test the
> waters of in-database rollups and analytical reads, and to initiate the
> software into those realms without standing up a separate stack on day one.
> They are not intended to be the de facto solution for serious ETL
> transformations, deep analytics, orchestration, streaming, warehouses, or BI
> platforms. When a project reaches that point, Sisal should hand off cleanly to
> specialized tools.

## Installing

Install the core packages plus one adapter. The package scope tells you which
registry you are using:

- Deno / JSR (primary): `jsr:@sisal/<package>`
- Node / npm: `@sisaljs/<package>`

The npm packages target Node.js 24+ as ESM-only packages.

For PostgreSQL on Deno through JSR:

```sh
deno add jsr:@sisal/orm@0.12.0 \
  jsr:@sisal/migrate@0.12.0 \
  jsr:@sisal/pg@0.12.0
```

For PostgreSQL on Node through npm:

```sh
npm i @sisaljs/orm@0.12.0 \
  @sisaljs/migrate@0.12.0 \
  @sisaljs/pg@0.12.0 \
  postgres
```

Most projects need exactly three Sisal packages: `@sisal/orm`, `@sisal/migrate`,
and one adapter package. On npm, install the adapter's database driver peer
dependency when it has one.

| Target        | Deno / JSR (`@sisal/*`)                                                             | Node / npm (`@sisaljs/*`)                                                                         |
| ------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| PostgreSQL    | `deno add jsr:@sisal/orm@0.12.0 jsr:@sisal/migrate@0.12.0 jsr:@sisal/pg@0.12.0`     | `npm i @sisaljs/orm@0.12.0 @sisaljs/migrate@0.12.0 @sisaljs/pg@0.12.0 postgres`                   |
| Neon          | `deno add jsr:@sisal/orm@0.12.0 jsr:@sisal/migrate@0.12.0 jsr:@sisal/neon@0.12.0`   | `npm i @sisaljs/orm@0.12.0 @sisaljs/migrate@0.12.0 @sisaljs/neon@0.12.0 @neondatabase/serverless` |
| SQLite        | `deno add jsr:@sisal/orm@0.12.0 jsr:@sisal/migrate@0.12.0 jsr:@sisal/sqlite@0.12.0` | `npm i @sisaljs/orm@0.12.0 @sisaljs/migrate@0.12.0 @sisaljs/sqlite@0.12.0`                        |
| libSQL/Turso  | `deno add jsr:@sisal/orm@0.12.0 jsr:@sisal/migrate@0.12.0 jsr:@sisal/libsql@0.12.0` | `npm i @sisaljs/orm@0.12.0 @sisaljs/migrate@0.12.0 @sisaljs/libsql@0.12.0 @libsql/client`         |
| MySQL/MariaDB | `deno add jsr:@sisal/orm@0.12.0 jsr:@sisal/migrate@0.12.0 jsr:@sisal/mysql@0.12.0`  | `npm i @sisaljs/orm@0.12.0 @sisaljs/migrate@0.12.0 @sisaljs/mysql@0.12.0 mysql2`                  |

`deno add` writes bare package aliases to `deno.json`, so application code can
import from `@sisal/orm`, `@sisal/migrate`, and the chosen adapter. On npm,
import from `@sisaljs/orm`, `@sisaljs/migrate`, and the chosen `@sisaljs/*`
adapter instead.

For the preview ETL and analytics layers, add the companion packages when you
need them:

```sh
deno add jsr:@sisal/etl@0.12.0 jsr:@sisal/analytics@0.12.0
npm i @sisaljs/etl@0.12.0 @sisaljs/analytics@0.12.0
```

## A Sisal Story

Imagine a product feed that starts as normal application tables, grows a ranked
timeline, and later needs hourly rollups for dashboards. Sisal keeps that path
boring in the best way: one set of typed table definitions feeds the query
builder, migration snapshots, ETL jobs, and analytical reads.

### 1. Define the model once

Start with the product model: users write posts, events record activity, and a
rollup table stores one row per post per hour. The table definitions are regular
TypeScript values, so they can be imported by application code, migration
config, ETL declarations, tests, and docs.

```ts
import {
  columns,
  defineTable,
  desc,
  index,
  type InferInsert,
  type InferSelect,
  primaryKey,
  sql,
} from "@sisal/orm";

export const users = defineTable("users", {
  id: columns.uuid().primaryKey(),
  email: columns.text().notNull().unique(),
  displayName: columns.text().notNull(),
  createdAt: columns.timestamp({ withTimezone: true, mode: "date" })
    .notNull(),
});

export const posts = defineTable("posts", {
  id: columns.uuid().primaryKey(),
  authorId: columns.uuid().notNull().references("users", "id"),
  title: columns.text().notNull(),
  status: columns.text().notNull(),
  score: columns.integer().notNull().default(0),
  createdAt: columns.timestamp({ withTimezone: true, mode: "date" })
    .notNull(),
}, (t) => [
  index("posts_feed_idx")
    .where(sql`${t.status} = 'published'`)
    .on(desc(t.score), desc(t.createdAt), desc(t.id)),
]);

export const postEvents = defineTable("post_events", {
  id: columns.bigserial().primaryKey(),
  postId: columns.uuid().notNull().references("posts", "id"),
  kind: columns.text().notNull(),
  occurredAt: columns.timestamp({ withTimezone: true, mode: "date" })
    .notNull(),
});

export const postHourlyStats = defineTable("post_hourly_stats", {
  postId: columns.uuid().notNull().references("posts", "id"),
  bucket: columns.timestamp({ withTimezone: true, mode: "date" }).notNull(),
  views: columns.integer().notNull(),
  votes: columns.integer().notNull(),
  comments: columns.integer().notNull(),
  engagementScore: columns.doublePrecision().notNull(),
}, (t) => [primaryKey({ columns: [t.postId, t.bucket] })]);

export type Post = InferSelect<typeof posts>;
export type NewPost = InferInsert<typeof posts>;
```

The value here is leverage. The model is not just runtime metadata and not just
types: it is the common contract for inserts, selects, joins, generated DDL,
rollups, and result-row inference.

### 2. Generate migrations with the CLI

Wire the migration CLI into your application's `deno.json`, then point
`sisal.migrate.ts` at the same tables your app imports.

```json
{
  "tasks": {
    "sisal": "deno run --allow-read --allow-write --allow-env --allow-net jsr:@sisal/migrate@0.12.0/cli",
    "db:init": "deno task sisal init --target postgres",
    "db:generate": "deno task sisal generate",
    "db:migrate": "deno task sisal migrate",
    "db:status": "deno task sisal status",
    "db:drift": "deno task sisal drift"
  }
}
```

Use `--target mysql` for MySQL/MariaDB. SQLite and libSQL/Turso tasks also need
`--allow-ffi`. `sisal init` creates `sisal.migrate.ts`:

```ts
import { createSchemaSnapshot } from "@sisal/orm";
import { defineConfig } from "@sisal/migrate/workflow";
import { postEvents, postHourlyStats, posts, users } from "./src/db/schema.ts";

export default defineConfig({
  dir: "migrations",
  dialect: "postgres",
  snapshot: createSchemaSnapshot({
    dialect: "postgres",
    tables: [users, posts, postEvents, postHourlyStats],
  }),
  databaseUrl: Deno.env.get("DATABASE_URL"),
  historyTable: "sisal_migrations",
});
```

Typical workflow:

```sh
deno task db:init
deno task db:generate create posts
deno task db:migrate
deno task db:status
deno task db:drift
```

`generate` diffs the latest `*.snapshot.json` in the migrations directory
against `config.snapshot`, then writes paired SQL and snapshot files. `drift`
exits with code `1` when the current schema snapshot, migration files, or
database plan do not match.

The value is reviewability. Generated SQL is checked into source control beside
the snapshot that produced it, and destructive changes are separated instead of
being smuggled into an ordinary migration.

### 3. Query the product surface

When the app needs a feed, use the same tables to build typed queries. This page
joins authors, filters published posts, and keyset-paginates by the index order.

```ts
import { desc, eq } from "@sisal/orm";
import type { PgDatabase } from "@sisal/pg";
import { posts, users } from "./schema.ts";

export async function getFeed(db: PgDatabase, after?: {
  score: number;
  createdAt: Date;
  id: string;
}) {
  return await db.select({
    id: posts.columns.id,
    title: posts.columns.title,
    author: users.columns.displayName,
    score: posts.columns.score,
    createdAt: posts.columns.createdAt,
  }).from(posts)
    .innerJoin(users, eq(users.columns.id, posts.columns.authorId))
    .where(eq(posts.columns.status, "published"))
    .keyset({
      orderBy: [
        desc(posts.columns.score),
        desc(posts.columns.createdAt),
        desc(posts.columns.id),
      ],
      after,
    })
    .limit(20)
    .execute();
}
```

The value is that query shape and result shape stay together. The selected
columns infer the row type, the cursor shape follows the keyset order, and SQL
fragments are rendered with parameters instead of string-concatenated values.

### 4. Keep advanced SQL close to the model

As the feed grows, you can still reach for analytical SQL patterns without
leaving the builder. This query ranks each post's strongest hourly buckets and
keeps the top three windows per post.

```ts
import { desc, gte, lte, over, rowNumber } from "@sisal/orm";
import type { PgDatabase } from "@sisal/pg";
import { postHourlyStats } from "./schema.ts";

export async function getBestHourlyWindows(db: PgDatabase, since: Date) {
  const h = postHourlyStats.columns;
  const ranked = db.select({
    postId: h.postId,
    bucket: h.bucket,
    engagementScore: h.engagementScore,
    rn: over(rowNumber(), {
      partitionBy: [h.postId],
      orderBy: [desc(h.engagementScore), desc(h.bucket)],
    }),
  }).from(postHourlyStats)
    .where(gte(h.bucket, since))
    .as("ranked");

  return await db.select({
    postId: ranked.postId,
    bucket: ranked.bucket,
    engagementScore: ranked.engagementScore,
  }).from(ranked)
    .where(lte(ranked.rn, 3))
    .execute();
}
```

The value is escape-hatch discipline. Sisal supports CTEs, subqueries, window
functions, aggregates, set operations, and raw `sql` fragments, but keeps them
inside the same typed SQL IR and adapter renderer.

### 5. Turn events into rollups with ETL

When raw events get too expensive to query repeatedly, define a job that folds
one closed time window per run. An external scheduler chooses when to wake up;
Sisal owns the checkpoint, advisory lock, generated `INSERT ... SELECT`, and
idempotent upsert for the window.

```ts
import { count, eq, filter, sql } from "@sisal/orm";
import { defineJob, run } from "@sisal/etl";
import type { PgDatabase } from "@sisal/pg";
import { postEvents, postHourlyStats } from "./schema.ts";

const e = postEvents.columns;

export const postHourlyStatsJob = defineJob({
  name: "post-hourly-stats",
  source: postEvents,
  target: postHourlyStats,
  window: e.occurredAt,
  grain: "hour",
  bucket: "bucket",
  groupBy: { postId: e.postId },
  aggregates: {
    views: filter(count(), eq(e.kind, "view")),
    votes: filter(count(), eq(e.kind, "vote")),
    comments: filter(count(), eq(e.kind, "comment")),
    engagementScore: sql`${filter(count(), eq(e.kind, "vote"))} * 2.0 + ${
      filter(count(), eq(e.kind, "comment"))
    } * 3.0`,
  },
  start: "2026-01-01T00:00:00.000Z",
});

export async function foldOneWindow(db: PgDatabase) {
  return await run(db, postHourlyStatsJob);
}
```

The value is a small ETL contract, not a new platform. `run()` folds one
half-open window, advances the watermark atomically with the write, and exits
cleanly if another runner already holds the job lock. See
[`examples/postgres-family-etl-cron`](examples/postgres-family-etl-cron/mod.ts)
for a runnable `Deno.cron` variant.

### 6. Read the rollups with analytics

The analytics preview sits on top of prepared tables like `post_hourly_stats`.
It describes dimensions, metrics, and windowed metrics, then renders or executes
one parameterized query.

```ts
import {
  bucket,
  descending,
  from,
  movingAvg,
  rank,
  sum,
} from "@sisal/analytics";
import type { PgDatabase } from "@sisal/pg";
import { postHourlyStats } from "./schema.ts";

export async function getRisingPosts(db: PgDatabase) {
  const rising = from(postHourlyStats)
    .dimensions({
      postId: postHourlyStats.columns.postId,
      bucket: bucket("hour", postHourlyStats.columns.bucket),
    })
    .metrics({
      votes: sum(postHourlyStats.columns.votes),
      comments: sum(postHourlyStats.columns.comments),
      engagement: sum(postHourlyStats.columns.engagementScore),
    })
    .windows({
      engagementMa6h: movingAvg("engagement", {
        partitionBy: ["postId"],
        orderBy: ["bucket"],
        rows: 6,
      }),
      hourlyRank: rank({
        partitionBy: ["bucket"],
        orderBy: [descending("engagement")],
      }),
    })
    .compareToPreviousWindow("engagement")
    .orderBy(descending("engagementMa6h"))
    .limit(50);

  return await rising.execute(db);
}
```

The value is a clean handoff from OLTP to lightweight OLAP. Your app keeps the
same database and adapter boundary, while dashboards and ranked feeds query
prepared rollups instead of rescanning raw event streams on every request.

## What You Get Today

- Typed schemas with `InferSelect` and `InferInsert`.
- Nullable-by-default columns, explicit `.notNull()`, `.optional()`, defaults,
  primary keys, unique constraints, checks, and foreign keys.
- Temporal-aware `date`, `time`, and `timestamp` columns, with legacy `Date` and
  raw string modes when requested.
- Typed SQL fragments with safe parameter rendering and explicit trusted escapes
  for identifiers or raw SQL.
- `select`, `insert`, `insert().select()`, `update`, and `delete` builders with
  guarded update/delete execution.
- Joins, aggregates, conditional aggregate `filter(...)`, ordering helpers,
  CTEs, set operations, `returning`, and upserts.
- Portable date helpers such as `dateTrunc`, `dateAdd`, `dateSub`, `dateBin`,
  and `now`.
- `sql` expressions in `values`, `set`, and upsert sets, plus `excluded(column)`
  for portable upsert set clauses.
- `db.batch([...])` for atomic non-interactive batches.
- Keyset pagination with inferred cursor shapes.
- `relations()` metadata and `db.query.<table>` helpers for schema-aware
  database facades.
- Typed database function callers through `defineFunction` and `db.call`.
- Schema snapshots v2, snapshot diffing, and additive DDL generation.
- Rich index DDL with `asc`/`desc`, partial `WHERE`, and expression keys.
- Migration planning, checksums, rollback, history stores, drift checks, and a
  CLI workflow.
- Adapter packages for PostgreSQL, Neon, SQLite, libSQL/Turso, and
  MySQL/MariaDB.
- Structured `SisalError`, `OrmError`, and `MigrationError` classes plus
  configurable logger contracts.

Sisal also includes the substrate the ETL layer builds on: a portable
advisory-lock/claim abstraction, an atomic load-and-advance checkpoint, and a
replay-vs-retention guard. The `@sisal/etl` preview (a typed rollup job + a
single-run, SQL-pushdown runner) and the `@sisal/analytics` preview are
lightweight by design, per the scope note above.

## Packages

Core packages:

| Package          | Purpose                                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `@sisal/core`    | The public driverless base: schema primitives, the SQL IR, expression operators, the capability registry, and the dialect renderer. |
| `@sisal/orm`     | Driverless schema definitions, typed SQL, query builders, snapshots, structured errors, and configurable logging.                   |
| `@sisal/migrate` | Adapter-neutral migrations, checksums, planning, drift checks, workflow helpers, generic runner, and CLI config.                    |

`@sisal/core` is a public package on both JSR and npm, but `@sisal/orm`
re-exports its entire surface — most projects install `@sisal/orm` +
`@sisal/migrate` + one adapter and never import `@sisal/core` directly. Depend
on it directly only when you want the schema/SQL-IR layer without the query
builders (as `@sisal/migrate` does).

Preview packages:

| Package            | Purpose                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `@sisal/etl`       | SQL-pushdown rollup jobs, checkpointed single-window runs, replay/backfill helpers, and dry-run explain.      |
| `@sisal/analytics` | Typed dimensions, metrics, windowed metrics, period-over-period helpers, and adapter-neutral query execution. |

Adapter packages:

| Package         | Purpose                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `@sisal/pg`     | PostgreSQL execution, pool boundary, migration history, migrator, and PostgreSQL DDL generation.                 |
| `@sisal/neon`   | Neon serverless PostgreSQL adapter over `@neon/serverless`, reusing PostgreSQL SQL, DDL, and migrator behavior.  |
| `@sisal/sqlite` | SQLite execution via `jsr:@db/sqlite`, migration history, migrator, and SQLite DDL generation.                   |
| `@sisal/libsql` | libSQL/Turso execution via `npm:@libsql/client`, migration history, migrator, and SQLite-compatible DDL aliases. |
| `@sisal/mysql`  | MySQL/MariaDB execution via `npm:mysql2` or the MariaDB connector, migration history, migrator, and MySQL DDL.   |

Core packages stay driverless and adapter-neutral. Adapter packages are where
database drivers and runtime-specific dependencies belong.

## Adapter Notes

- PostgreSQL uses the PostgreSQL dialect, placeholders, schema support, and DDL
  helpers through `@sisal/pg`. It defaults to `jsr:@db/postgres`; opt into the
  faster postgres.js path with `connect({ url, driver: "postgres-js" })`, and
  use `prepare: false` for PgBouncer or pooled endpoints when needed.
- Neon uses serverless PostgreSQL over `@neon/serverless` through `@sisal/neon`.
- SQLite runs local SQLite through `jsr:@db/sqlite`; Deno execution needs
  `--allow-ffi`.
- libSQL/Turso follows the SQLite-compatible dialect through
  `npm:@libsql/client`.
- MySQL/MariaDB use `@sisal/mysql` with `mysql2` by default; opt into the
  MariaDB connector with `connect({ url, driver: "mariadb" })`.

## Development

Common repository checks:

```sh
deno task fmt:check
deno lint
deno task check
deno task test
deno task docs:check
deno task docs:llms:check
deno task docs:matrix:check
```

Integration suites are opt-in because they use real database drivers or
services:

```sh
DATABASE_URL=postgres://... deno test -A integration/pg_features_test.ts
SISAL_PG_DRIVER=postgres-js DATABASE_URL=postgres://... \
  deno test -A integration/pg_features_test.ts
NEON_DATABASE_URL=postgres://... deno test -A integration/neon_features_test.ts
SISAL_SQLITE_IT=1 deno test --allow-ffi --allow-read --allow-write \
  --allow-env --allow-net integration/sqlite_features_test.ts
SISAL_LIBSQL_IT=1 deno test -A integration/libsql_features_test.ts
SISAL_MYSQL_IT=1 MYSQL_URL=mysql://... deno test -A integration/mysql_features_test.ts
SISAL_MARIADB_IT=1 MARIADB_URL=mysql://... deno test -A integration/mariadb_features_test.ts
DATABASE_URL=postgres://... deno test --allow-net --allow-env --allow-read \
  integration/pg_migrate_apply_test.ts
DATABASE_URL=postgres://... deno test --allow-net --allow-env --allow-read \
  integration/analytics_features_test.ts
DATABASE_URL=postgres://... deno test --allow-net --allow-env --allow-read \
  --allow-ffi integration/cross_adapter_parity_test.ts
```

The scheduled integration workflow covers PostgreSQL 16/17/18 through Docker,
Neon through the bundled local WebSocket proxy, local SQLite/libSQL execution,
and MySQL/MariaDB through Docker services.

## README Disclaimer

This README was generated and revised with AI assistance. It may contain errors,
omissions, outdated examples, or inaccuracies. The source code, package
manifests, tests, and generated API documentation are the authoritative project
references.
