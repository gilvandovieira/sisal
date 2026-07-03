# @sisal/pg

PostgreSQL adapter boundary for Sisal.

`@sisal/pg` depends on `@sisal/orm` and `@sisal/migrate`; neither package
depends on `@sisal/pg`. It provides PostgreSQL database execution, connection
pooling, migration history storage, migrators, and additive DDL generation.

```ts
import { createPgDb } from "@sisal/pg";

const db = await createPgDb({
  url: Deno.env.get("DATABASE_URL"),
});
```

## Choosing a driver

`@sisal/pg` runs on either of two PostgreSQL drivers behind the same query
builder and executor — the only difference is the connection option, so
application code is identical:

```ts
// Default (since v0.10): postgres.js (`npm:postgres`), imported lazily on the
// first connect. Sets TCP_NODELAY and pipelines the protocol — ~100× faster
// per parameterized query than `@db/postgres`'s extended-protocol path. Set
// `prepare: false` for PgBouncer/Neon-pooled endpoints.
const db = await createPgDb({ url });

// Pure-JSR `jsr:@db/postgres` (the pre-v0.10 default) — select it to keep the
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
