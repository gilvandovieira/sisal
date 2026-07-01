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
// Default: pure-JSR `jsr:@db/postgres`.
const db = await createPgDb({ url });

// postgres.js (`npm:postgres`), imported lazily. Avoids `@db/postgres`'s
// ~40 ms/query extended-protocol stall (~100× faster per query). Set
// `prepare: false` for PgBouncer/Neon-pooled endpoints.
const fast = await createPgDb({ url, driver: "postgres-js", prepare: false });
```

Both pass the full `@sisal/pg` compatibility matrix (PostgreSQL 16/17/18). The
default stays `@db/postgres` so `@sisal/pg` is npm-free out of the box; opting
into `"postgres-js"` pulls `npm:postgres`. The full analysis lives in the
repository at `perf/PG_ADAPTER_PERF_REPORT.md`.

For only DDL generation:

```ts
import { generatePostgresUpStatements } from "@sisal/pg/ddl";
```
