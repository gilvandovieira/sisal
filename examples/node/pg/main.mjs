// Sisal on Node with PostgreSQL via postgres.js. Install the driver alongside
// the adapter (`npm i @sisaljs/pg postgres`) and point DATABASE_URL at your
// database, then: `node main.mjs` (Node 24+).
//
//   docker compose -f ../../../docker/compose.yaml up -d pg16
//   DATABASE_URL=postgres://postgres:postgres@localhost:55416/sisal node main.mjs
import { columns, createSchemaSnapshot, defineTable, eq } from "@sisaljs/orm";
import { connect } from "@sisaljs/pg";
import { generatePostgresUpStatements } from "@sisaljs/pg/ddl";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("set DATABASE_URL");

const posts = defineTable("posts", {
  id: columns.integer().primaryKey(),
  title: columns.text().notNull(),
  views: columns.integer().notNull().default(0),
});

const { statements } = generatePostgresUpStatements(
  createSchemaSnapshot({ dialect: "postgres", tables: [posts] }),
);

// The postgres.js pool prepares queries by default (parse+plan once, then
// reuse); pass `connect({ url, prepare: false })` for PgBouncer/Neon pooling.
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
