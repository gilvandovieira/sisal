/**
 * Basic PostgreSQL DDL generation example for Sisal.
 *
 * @module
 */

import { columns, createSchemaSnapshot, defineTable } from "@sisal/orm";
import { generatePostgresUpStatements } from "@sisal/pg/ddl";

const users = defineTable("users", {
  id: columns.uuid().primaryKey(),
  email: columns.text().notNull().unique(),
  name: columns.text().notNull(),
  createdAt: columns.timestamp({ withTimezone: true }).notNull(),
});

const snapshot = createSchemaSnapshot({
  dialect: "postgres",
  tables: [users],
});

const migration = generatePostgresUpStatements(snapshot);

console.log(migration.statements.join("\n\n"));
