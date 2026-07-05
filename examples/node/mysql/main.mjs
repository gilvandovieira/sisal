// Sisal on Node with MySQL/MariaDB via mysql2. Install the driver alongside the
// adapter (`npm i @sisaljs/mysql mysql2`) and point MYSQL_URL at your database,
// then: `node main.mjs` (Node 24+).
//
//   docker compose -f ../../../docker/compose.yaml up -d mysql
//   MYSQL_URL=mysql://root:root@localhost:33306/sisal node main.mjs
//
// For MariaDB, install `mariadb` and pass `connect({ url, driver: "mariadb" })`.
import { columns, createSchemaSnapshot, defineTable, eq } from "@sisaljs/orm";
import { connect } from "@sisaljs/mysql";
import { generateMysqlUpStatements } from "@sisaljs/mysql/ddl";

const url = process.env.MYSQL_URL;
if (!url) throw new Error("set MYSQL_URL");

const posts = defineTable("posts", {
  id: columns.integer().primaryKey(),
  title: columns.text().notNull(),
  views: columns.integer().notNull().default(0),
});

const { statements } = generateMysqlUpStatements(
  createSchemaSnapshot({ dialect: "mysql", tables: [posts] }),
);

const db = await connect({ url });
try {
  await db.execute("drop table if exists posts");
  for (const statement of statements) await db.execute(statement);

  await db.insert(posts).values([
    { id: 1, title: "hello", views: 10 },
    { id: 2, title: "world", views: 20 },
  ]).execute();

  const popular = await db.select()
    .from(posts)
    .where(eq(posts.columns.views, 20))
    .execute();

  console.log("popular posts:", popular);
} finally {
  await db.close();
}
