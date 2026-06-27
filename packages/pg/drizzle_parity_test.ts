/**
 * Drizzle ORM 0.45.2 parity tests for `@sisal/pg` DDL generation.
 *
 * Compares Sisal's pure Postgres DDL output against the equivalent
 * `drizzle-kit` generate shape (type mapping + CREATE TABLE). These tests are
 * connection-free — they never touch `@db/postgres`.
 *
 * See ../../docs/drizzle-parity.md (section 5).
 */
import { assertEquals } from "@std/assert";
import { columns, createSchemaSnapshot, defineTable } from "@sisal/orm";
import {
  generatePostgresColumnType,
  generatePostgresUpStatements,
} from "./migrate/ddl.ts";

Deno.test("parity: Postgres column type mapping mirrors drizzle pg-core", () => {
  assertEquals(generatePostgresColumnType({ kind: "uuid" }), "uuid");
  assertEquals(
    generatePostgresColumnType({ kind: "varchar", length: 255 }),
    "varchar(255)",
  );
  assertEquals(generatePostgresColumnType({ kind: "integer" }), "integer");
  assertEquals(generatePostgresColumnType({ kind: "boolean" }), "boolean");
  assertEquals(generatePostgresColumnType({ kind: "jsonb" }), "jsonb");
  // Divergence: `timestamp` maps to `timestamptz` in Sisal's Postgres DDL.
  assertEquals(
    generatePostgresColumnType({ kind: "timestamp" }),
    "timestamptz",
  );
  assertEquals(generatePostgresColumnType({ kind: "bytea" }), "bytea");
  assertEquals(
    generatePostgresColumnType({ kind: "text", array: true }),
    "text[]",
  );
});

Deno.test("parity: defineTable -> Postgres CREATE TABLE", () => {
  const users = defineTable("users", {
    id: columns.uuid().primaryKey(),
    email: columns.varchar(255).notNull().unique(),
  });
  const snapshot = createSchemaSnapshot({
    dialect: "postgres",
    tables: [users],
  });
  const { statements } = generatePostgresUpStatements(snapshot);

  assertEquals(statements, [
    'CREATE TABLE "users" (\n' +
    '  "id" uuid NOT NULL,\n' +
    '  "email" varchar(255) NOT NULL,\n' +
    '  PRIMARY KEY ("id"),\n' +
    '  UNIQUE ("email")\n' +
    ");",
  ]);
});

Deno.test("parity: foreign keys + actions emit as ALTER after CREATE", () => {
  const orgs = defineTable("orgs", { id: columns.uuid().primaryKey() });
  const users = defineTable("users", {
    id: columns.uuid().primaryKey(),
    orgId: columns.uuid().references("orgs", "id", {
      onDelete: "cascade",
      onUpdate: "restrict",
    }),
  });
  const { statements } = generatePostgresUpStatements(
    createSchemaSnapshot({ dialect: "postgres", tables: [orgs, users] }),
  );

  // Foreign keys are added after every CREATE TABLE (forward-reference safe).
  assertEquals(
    statements.at(-1),
    'ALTER TABLE "users" ADD FOREIGN KEY ("orgId") REFERENCES "orgs" ("id") ' +
      "ON DELETE CASCADE ON UPDATE RESTRICT;",
  );
});
