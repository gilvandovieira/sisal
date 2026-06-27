/**
 * Drizzle ORM 0.45.2 parity tests for `@sisal/sqlite` DDL generation.
 *
 * Compares Sisal's pure SQLite DDL output against the equivalent `drizzle-kit`
 * generate shape (affinity mapping + CREATE TABLE). Connection-free — these
 * never touch `@db/sqlite`.
 *
 * See ../../docs/drizzle-parity.md (sections 1 and 5).
 */
import { assertEquals } from "@std/assert";
import { columns, createSchemaSnapshot, defineTable } from "@sisal/orm";
import {
  generateSqliteColumnType,
  generateSqliteUpStatements,
} from "./migrate/ddl.ts";

Deno.test("parity: SQLite type affinity mapping", () => {
  assertEquals(generateSqliteColumnType({ kind: "integer" }), "INTEGER");
  assertEquals(generateSqliteColumnType({ kind: "boolean" }), "INTEGER");
  assertEquals(generateSqliteColumnType({ kind: "number" }), "REAL");
  assertEquals(generateSqliteColumnType({ kind: "text" }), "TEXT");
  assertEquals(generateSqliteColumnType({ kind: "uuid" }), "TEXT");
  assertEquals(generateSqliteColumnType({ kind: "blob" }), "BLOB");
});

Deno.test("parity: defineTable -> SQLite CREATE TABLE (nullable by default)", () => {
  const notes = defineTable("notes", {
    id: columns.text().primaryKey(), // primary key implies NOT NULL
    title: columns.text().notNull(), // explicit NOT NULL
    // Nullable by default (like Drizzle): NOT NULL is absent, DEFAULT remains.
    archived: columns.boolean().default(false),
  });
  const snapshot = createSchemaSnapshot({ dialect: "sqlite", tables: [notes] });
  const { statements } = generateSqliteUpStatements(snapshot);

  assertEquals(statements, [
    'CREATE TABLE "notes" (\n' +
    '  "id" TEXT NOT NULL,\n' +
    '  "title" TEXT NOT NULL,\n' +
    '  "archived" INTEGER DEFAULT 0,\n' +
    '  PRIMARY KEY ("id")\n' +
    ");",
  ]);
});
