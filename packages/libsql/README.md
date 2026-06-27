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
