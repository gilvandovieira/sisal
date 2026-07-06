# @sisal/neon

Neon serverless PostgreSQL adapter boundary for Sisal.

`@sisal/neon` uses the Neon serverless driver (`@neon/serverless` on JSR,
`@neondatabase/serverless` on npm) and reuses the Postgres SQL dialect, ORM
driver, migrator, and DDL helpers from `@sisal/pg`.

> **Install** — same package, registry-specific scopes:
>
> - JSR / Deno (`@sisal/*`): `deno add jsr:@sisal/neon`
> - npm / Node 24+ (`@sisaljs/*`):
>   `npm i @sisaljs/neon @neondatabase/serverless`
>
> Examples use the JSR import (`@sisal/neon`); on npm import from
> `@sisaljs/neon`. The serverless driver is a peer dependency you install
> yourself.

```ts
import { connect } from "@sisal/neon";

// `url` is your Neon connection string — e.g. process.env.DATABASE_URL on Node,
// Deno.env.get("DATABASE_URL") on Deno.
const db = await connect({ url });
```

For migrations:

```ts
import { createNeonMigrator } from "@sisal/neon/migrate";

const migrator = await createNeonMigrator({ url });
```

For only DDL generation:

```ts
import { generatePostgresUpStatements } from "@sisal/neon/ddl";
```

## Adapter checklist

| Question            | Answer                                                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Driver              | `jsr:@neon/serverless`, reusing PostgreSQL ORM, DDL, and migration behavior through the `@sisal/pg` package boundary.                                     |
| Permissions (Deno)  | `--allow-env` for DSNs/tokens and `--allow-net` for Neon HTTP/WebSocket endpoints.                                                                        |
| Migrations          | Yes: `@sisal/neon/migrate`; multi-statement SQL is split because Neon HTTP accepts one statement per call.                                                |
| Transactions/batch  | Transactions use pooled Neon clients where supported; batch semantics follow the PostgreSQL-family adapter boundary.                                      |
| Dialect limitations | PostgreSQL SQL rendering with Neon transport constraints; use `dialectIdentity` for capability gates.                                                     |
| Security caveats    | Keep connection strings and tokens secret, require TLS-capable Neon endpoints, and treat migration SQL/config as trusted local code.                      |
| ETL                 | Works with `@sisal/etl` through the PostgreSQL dialect; use scheduler/serverless timeout budgets carefully.                                               |
| Analytics           | Works with `@sisal/analytics` for PostgreSQL-compatible analytical SQL; live proof is currently on PostgreSQL, with Neon sharing the render/dialect path. |
