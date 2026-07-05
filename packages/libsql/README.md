# @sisal/libsql

libSQL and Turso adapter boundary for Sisal.

`@sisal/libsql` depends on `@sisal/orm`, `@sisal/migrate`, and `@sisal/sqlite`
for pure SQLite DDL generation. It provides libSQL/Turso query execution,
migration history storage, migrators, and SQLite-compatible additive DDL
aliases.

> **Install** — JSR (Deno): `deno add jsr:@sisal/libsql` · npm (Node 24+):
> `npm i @sisaljs/libsql @libsql/client`. Same package on both registries under
> different scopes (**`@sisal/*` on JSR**, **`@sisaljs/*` on npm**); examples
> use the JSR import, on npm import from `@sisaljs/libsql`. The `@libsql/client`
> driver is a peer dependency you install yourself.

```ts
import { createLibsqlDb } from "@sisal/libsql";

// Read the URL/token from your environment — e.g. process.env.TURSO_DATABASE_URL
// on Node, Deno.env.get("TURSO_DATABASE_URL") on Deno.
const db = await createLibsqlDb({ url, authToken });
```

For only DDL generation:

```ts
import { generateLibsqlUpStatements } from "@sisal/libsql/ddl";
```

## Adapter checklist

| Question            | Answer                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Driver              | `npm:@libsql/client`; DDL aliases reuse the SQLite adapter boundary.                                                                                               |
| Permissions (Deno)  | `--allow-env` for URLs/tokens, `--allow-net` for remote Turso/libSQL, and `--allow-read`/`--allow-write` for local `file:` databases.                              |
| Migrations          | Yes: `@sisal/libsql/migrate`, libSQL history store, and SQLite-compatible DDL aliases.                                                                             |
| Transactions/batch  | Transaction support follows the libSQL client; `db.batch` uses the adapter's scoped execution path.                                                                |
| Dialect limitations | SQLite-compatible SQL with libSQL/Turso transport behavior; use `dialectIdentity` for gates.                                                                       |
| Security caveats    | Treat `TURSO_AUTH_TOKEN` and remote URLs as secrets; avoid logging DSNs/tokens; raw SQL/migrations remain trusted developer input.                                 |
| ETL                 | Works for portable SQLite-family rollup shapes where the client supports the required transaction/batch behavior; live claims require named integration scenarios. |
| Analytics           | Basic analytics SQL renders for SQLite-family targets; non-PostgreSQL analytics execution is not claimed live without a named integration test.                    |
