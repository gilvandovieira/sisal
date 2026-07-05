# @sisal/pg

PostgreSQL adapter boundary for Sisal.

`@sisal/pg` depends on `@sisal/orm` and `@sisal/migrate`; neither package
depends on `@sisal/pg`. It provides PostgreSQL database execution, connection
pooling, migration history storage, migrators, and additive DDL generation.

> **Install** — JSR (Deno): `deno add jsr:@sisal/pg` · npm (Node 24+):
> `npm i @sisaljs/pg postgres`. Same package on both registries under different
> scopes (**`@sisal/*` on JSR**, **`@sisaljs/*` on npm**); examples use the JSR
> import, on npm import from `@sisaljs/pg`. The `postgres` (postgres.js) driver
> is a peer dependency you install yourself.

```ts
import { createPgDb } from "@sisal/pg";

// `url` is your PostgreSQL connection string — e.g. process.env.DATABASE_URL on
// Node, Deno.env.get("DATABASE_URL") on Deno.
const db = await createPgDb({ url });
```

## Choosing a driver

`@sisal/pg` runs on either of two PostgreSQL drivers behind the same query
builder and executor — the only difference is the connection option, so
application code is identical:

```ts
// Default: postgres.js (`npm:postgres`), imported lazily on the
// first connect. Sets TCP_NODELAY and pipelines the protocol — ~100× faster
// per parameterized query than `@db/postgres`'s extended-protocol path. Set
// `prepare: false` for PgBouncer/Neon-pooled endpoints.
const db = await createPgDb({ url });

// Pure-JSR `jsr:@db/postgres` — select it to keep the
// process npm-free.
const jsrOnly = await createPgDb({ url, driver: "db-postgres" });
```

Both pass the full `@sisal/pg` compatibility matrix (PostgreSQL 16/17/18),
including identical `bigint` (`int8` → string) decoding. The migrate boundary
(`@sisal/pg/migrate`) stays on `@db/postgres` — migrations are short-lived and
latency-insensitive, and this keeps `sisal` CLI runs npm-free. The full analysis
lives in the repository at `perf/PG_ADAPTER_PERF_REPORT.md`.

For only DDL generation:

```ts
import { generatePostgresUpStatements } from "@sisal/pg/ddl";
```

## Adapter checklist

| Question            | Answer                                                                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Driver              | ORM connections use lazy `npm:postgres` by default or `jsr:@db/postgres` when `driver: "db-postgres"` is selected. Migration execution uses `@db/postgres`.                |
| Permissions (Deno)  | `--allow-env` for DSNs, `--allow-net=<host>:<port>` for live connections, and `--allow-read` when loading local config/migrations.                                         |
| Migrations          | Yes: `@sisal/pg/migrate`, PostgreSQL history store, advisory locks, and `@sisal/pg/ddl`.                                                                                   |
| Transactions/batch  | Interactive transactions and atomic `db.batch` are supported through scoped executors.                                                                                     |
| Dialect limitations | PostgreSQL-family features are capability-gated by `dialectIdentity`; `int8` decodes as string to avoid precision loss.                                                    |
| Security caveats    | Treat DSNs as secrets, prefer TLS for remote hosts, and keep raw SQL/migration files developer-authored. Driver errors are redacted before surfacing through Sisal errors. |
| ETL                 | Works with `@sisal/etl`; PostgreSQL is the primary live-proven ETL target.                                                                                                 |
| Analytics           | Works with `@sisal/analytics`; PostgreSQL has live integration proof for bucket/window/previous-window analytics.                                                          |
