// Sisal on Node with the built-in `node:sqlite` driver — no external database,
// no npm driver to install. Run with: `node main.mjs` (Node 24+).
import { columns, createSchemaSnapshot, defineTable, eq } from "@sisaljs/orm";
import { connect } from "@sisaljs/sqlite";
import { generateSqliteUpStatements } from "@sisaljs/sqlite/ddl";

// 1. Define the schema. Columns are nullable by default (like SQL/Drizzle);
//    `.notNull()` / `.primaryKey()` opt out. Column names default to snake_case.
const posts = defineTable("posts", {
  id: columns.integer().primaryKey(),
  title: columns.text().notNull(),
  views: columns.integer().notNull().default(0),
});

// 2. Generate the additive CREATE TABLE from a schema snapshot.
const { statements } = generateSqliteUpStatements(
  createSchemaSnapshot({ dialect: "sqlite", tables: [posts] }),
);

// 3. Connect (in-memory here) and run typed queries through the builder.
const db = await connect({ path: ":memory:" });
try {
  for (const statement of statements) await db.execute(statement);

  await db.insert(posts).values([
    { id: 1, title: "hello", views: 10 },
    { id: 2, title: "world", views: 20 },
  ]).execute();

  const popular = await db.select()
    .from(posts)
    .where(eq(posts.columns.views, 20))
    .execute();

  console.log("popular posts:", popular); // [{ id: 2, title: "world", views: 20 }]
} finally {
  await db.close();
}
