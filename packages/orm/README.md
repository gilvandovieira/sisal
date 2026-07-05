# @sisal/orm

Driverless ORM, schema, and typed SQL primitives for Sisal.

`@sisal/orm` has no hard dependency on PostgreSQL, SQLite, Pequi Logger, or any
legacy package. It can define tables, infer insert/select shapes, render
parameterized SQL, and produce serializable schema snapshots consumed by
`@sisal/migrate` and adapter packages.

> **Install** — JSR (Deno): `deno add jsr:@sisal/orm` · npm (Node 24+):
> `npm i @sisaljs/orm`. Same package on both registries under different scopes
> (**`@sisal/*` on JSR**, **`@sisaljs/*` on npm**); examples use the JSR import,
> on npm import from `@sisaljs/orm`.

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

Release-safety notes:

- `@sisal/orm` is driverless and must not import adapters, ETL, analytics, or
  migration execution code.
- `raw(...)`, `sql.raw(...)`-style escape hatches, and `db.execute("...")` are
  for trusted SQL only. Runtime values belong in `sql\`...\${value}\`` so the
  renderer binds them as parameters.
- `update` and `delete` require a `where` clause unless `.unsafeAllowAllRows()`
  is called explicitly.
- Insert/update builders reject unknown object keys instead of mass-assigning
  them into SQL.
- Logging and structured errors redact parameter values, DSNs, auth tokens, and
  driver error causes. Use the `logging.sql.parameters` setting to choose
  redacted summaries or no bind summaries at all.
- `Database` exposes `dialectIdentity`, `transaction`, and `batch` so preview
  layers such as ETL and analytics can capability-gate work without depending on
  adapters.
