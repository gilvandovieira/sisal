import { columns, createSchemaSnapshot, defineTable } from "@sisal/orm";
import { generateSqliteUpStatements } from "@sisal/sqlite/ddl";

const notes = defineTable("notes", {
  id: columns.text().primaryKey(),
  title: columns.text().notNull(),
  body: columns.text().optional(),
  archived: columns.boolean().default(false),
});

const snapshot = createSchemaSnapshot({
  dialect: "sqlite",
  tables: [notes],
});

const migration = generateSqliteUpStatements(snapshot);

console.log(migration.statements.join("\n\n"));
