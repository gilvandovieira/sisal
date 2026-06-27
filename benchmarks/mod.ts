import {
  columns,
  createSchemaSnapshot,
  defineTable,
  renderSql,
  sql,
} from "@sisal/orm";

const users = defineTable("users", {
  id: columns.uuid().primaryKey(),
  email: columns.text().notNull(),
});

Deno.bench("render parameterized sql", () => {
  renderSql(sql`select * from users where id = ${"u_1"}`, {
    dialect: "postgres",
  });
});

Deno.bench("create schema snapshot", () => {
  createSchemaSnapshot({ tables: [users] });
});
