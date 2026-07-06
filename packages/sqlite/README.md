# @sisal/sqlite

SQLite adapter boundary for Sisal.

`@sisal/sqlite` depends on `@sisal/orm` and `@sisal/migrate`; neither package
depends on `@sisal/sqlite`. It provides SQLite database execution, migration
history storage, migrators, and additive DDL generation.

> **Install** — same package, registry-specific scopes:
>
> - JSR / Deno (`@sisal/*`): `deno add jsr:@sisal/sqlite`
> - npm / Node 24+ (`@sisaljs/*`): `npm i @sisaljs/sqlite`
>
> Examples use the JSR import (`@sisal/sqlite`); on npm import from
> `@sisaljs/sqlite`. No driver to install: it uses Deno's `@db/sqlite` (FFI) on
> Deno and the built-in `node:sqlite` on Node.

```ts
import { createSqliteDb } from "@sisal/sqlite";

const db = await createSqliteDb({ path: ":memory:" });
```

For only DDL generation:

```ts
import { generateSqliteUpStatements } from "@sisal/sqlite/ddl";
```

## Adapter checklist

| Question            | Answer                                                                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Driver              | `@db/sqlite` through Deno FFI.                                                                                                                                                            |
| Permissions (Deno)  | `--allow-ffi`; add `--allow-read`/`--allow-write` for file-backed databases.                                                                                                              |
| Migrations          | Yes: `@sisal/sqlite/migrate`, SQLite history store, and `@sisal/sqlite/ddl`.                                                                                                              |
| Transactions/batch  | Interactive transactions are serialized on one connection; `db.batch` runs atomically through a transaction.                                                                              |
| Dialect limitations | SQLite type affinity applies; booleans are stored as integers, `@db/sqlite` is opened with `int64` support, and some PostgreSQL/MySQL DDL/index features are capability-gated or omitted. |
| Security caveats    | Protect file paths and file permissions; raw SQL and migration files are trusted code; FFI permission is required for the native driver.                                                  |
| ETL                 | Render/unit support exists for portable rollup shapes; live ETL claims require named SQLite integration scenarios.                                                                        |
| Analytics           | Basic analytics SQL renders for SQLite where supported; non-PostgreSQL analytics execution is render/golden-SQL proven unless a live integration test is named.                           |
