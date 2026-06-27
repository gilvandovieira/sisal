# @sisal/orm

Driverless ORM, schema, and typed SQL primitives for Sisal.

`@sisal/orm` has no hard dependency on PostgreSQL, SQLite, Pequi Logger, or any
legacy package. It can define tables, infer insert/select shapes, render
parameterized SQL, and produce serializable schema snapshots consumed by
`@sisal/migrate` and adapter packages.

```ts
import { columns, defineTable, eq, renderSql, sql } from "@sisal/orm";

const users = defineTable("users", {
  id: columns.uuid().primaryKey(),
  email: columns.text().notNull(),
});

const query = sql`select * from users where id = ${"u_1"}`;
const rendered = renderSql(query, { dialect: "postgres" });
```

Use `@sisal/pg` or `@sisal/sqlite` when you need a concrete database driver.
