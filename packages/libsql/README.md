# @sisal/libsql

libSQL and Turso adapter boundary for Sisal.

`@sisal/libsql` depends on `@sisal/orm`, `@sisal/migrate`, and `@sisal/sqlite`
for pure SQLite DDL generation. It provides libSQL/Turso query execution,
migration history storage, migrators, and SQLite-compatible additive DDL
aliases.

```ts
import { createLibsqlDb } from "@sisal/libsql";

const db = await createLibsqlDb({
  url: Deno.env.get("TURSO_DATABASE_URL")!,
  authToken: Deno.env.get("TURSO_AUTH_TOKEN"),
});
```

For only DDL generation:

```ts
import { generateLibsqlUpStatements } from "@sisal/libsql/ddl";
```

## Adapter checklist

| Question            | Answer                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Driver              | `npm:@libsql/client`; DDL aliases reuse the SQLite adapter boundary.                                                                                               |
| Permissions         | `--allow-env` for URLs/tokens, `--allow-net` for remote Turso/libSQL, and `--allow-read`/`--allow-write` for local `file:` databases.                              |
| Migrations          | Yes: `@sisal/libsql/migrate`, libSQL history store, and SQLite-compatible DDL aliases.                                                                             |
| Transactions/batch  | Transaction support follows the libSQL client; `db.batch` uses the adapter's scoped execution path.                                                                |
| Dialect limitations | SQLite-compatible SQL with libSQL/Turso transport behavior; use `dialectIdentity` for gates.                                                                       |
| Security caveats    | Treat `TURSO_AUTH_TOKEN` and remote URLs as secrets; avoid logging DSNs/tokens; raw SQL/migrations remain trusted developer input.                                 |
| ETL                 | Works for portable SQLite-family rollup shapes where the client supports the required transaction/batch behavior; live claims require named integration scenarios. |
| Analytics           | Basic analytics SQL renders for SQLite-family targets; non-PostgreSQL analytics execution is not claimed live without a named integration test.                    |
