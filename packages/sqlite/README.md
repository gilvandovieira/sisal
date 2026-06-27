# @sisal/sqlite

SQLite adapter boundary for Sisal.

`@sisal/sqlite` depends on `@sisal/orm` and `@sisal/migrate`; neither package
depends on `@sisal/sqlite`. It provides SQLite database execution, migration
history storage, migrators, and additive DDL generation.

```ts
import { createSqliteDb } from "@sisal/sqlite";

const db = await createSqliteDb({ path: ":memory:" });
```

For only DDL generation:

```ts
import { generateSqliteUpStatements } from "@sisal/sqlite/ddl";
```
