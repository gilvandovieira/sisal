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

For only DDL generation:

```ts
import { generatePostgresUpStatements } from "@sisal/pg/ddl";
```
