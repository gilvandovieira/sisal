# @sisal/neon

Neon serverless PostgreSQL adapter boundary for Sisal.

`@sisal/neon` uses `jsr:@neon/serverless` and reuses the Postgres SQL dialect,
ORM driver, migrator, and DDL helpers from `@sisal/pg`.

```ts
import { connect } from "@sisal/neon";

const db = await connect({
  url: Deno.env.get("DATABASE_URL"),
});
```

For migrations:

```ts
import { createNeonMigrator } from "@sisal/neon/migrate";

const migrator = await createNeonMigrator({
  url: Deno.env.get("DATABASE_URL"),
});
```

For only DDL generation:

```ts
import { generatePostgresUpStatements } from "@sisal/neon/ddl";
```
