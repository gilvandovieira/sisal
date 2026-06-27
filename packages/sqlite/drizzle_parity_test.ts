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

Deno.test("parity + divergence: defineTable -> SQLite CREATE TABLE (NOT NULL by default)", () => {
  const notes = defineTable("notes", {
    id: columns.text().primaryKey(),
    title: columns.text().notNull(),
    // .default() does not relax nullability, so this is NOT NULL DEFAULT 0.
    archived: columns.boolean().default(false),
  });
  const snapshot = createSchemaSnapshot({ dialect: "sqlite", tables: [notes] });
  const { statements } = generateSqliteUpStatements(snapshot);

  assertEquals(statements, [
    'CREATE TABLE "notes" (\n' +
    '  "id" TEXT NOT NULL,\n' +
    '  "title" TEXT NOT NULL,\n' +
    '  "archived" INTEGER NOT NULL DEFAULT 0,\n' +
    '  PRIMARY KEY ("id")\n' +
    ");",
  ]);
});
