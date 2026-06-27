/**
 * Basic libSQL/Turso execution example for Sisal.
 *
 * @module
 */

import { columns, createSchemaSnapshot, defineTable, sql } from "@sisal/orm";
import { connect, generateLibsqlUpStatements } from "@sisal/libsql";

const notes = defineTable("notes", {
  id: columns.text().primaryKey(),
  title: columns.text().notNull(),
  archived: columns.boolean().default(false),
});

const snapshot = createSchemaSnapshot({
  dialect: "sqlite",
  tables: [notes],
});

const db = await connect({
  url: Deno.env.get("TURSO_DATABASE_URL") ?? "file:./sisal-libsql-example.db",
  authToken: Deno.env.get("TURSO_AUTH_TOKEN"),
});

try {
  const { statements } = generateLibsqlUpStatements(snapshot);
  for (const statement of statements) {
    await db.execute(statement);
  }

  await db.insert(notes).values({
    id: crypto.randomUUID(),
    title: "libSQL note",
  }).execute();

  const result = await db.query<{ count: number }>(
    sql`select count(*) as count from notes`,
  );
  console.log(`notes: ${Number(result.rows[0].count)}`);
} finally {
  await db.close();
}
