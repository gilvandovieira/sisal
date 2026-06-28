/**
 * Drizzle ORM 0.45.2 parity tests for `@sisal/sqlite` DDL generation.
 *
 * Compares Sisal's pure SQLite DDL output against the equivalent `drizzle-kit`
 * generate shape (affinity mapping + CREATE TABLE). Connection-free — these
 * never touch `@db/sqlite`.
 *
 * See ../../docs/drizzle-parity.md (sections 1 and 5).
 */
import { assert, assertEquals } from "@std/assert";
import {
  check,
  columns,
  createSchemaSnapshot,
  defineTable,
  index,
  primaryKey,
  sql,
  unique,
} from "@sisal/orm";
import {
  generateSqliteColumnType,
  generateSqliteUpStatements,
} from "./migrate/ddl.ts";

Deno.test("parity: table extras — composite PK, named unique, check, index", () => {
  const members = defineTable("members", {
    orgId: columns.integer(),
    userId: columns.integer(),
    email: columns.text().notNull(),
    age: columns.integer(),
  }, (t) => [
    primaryKey({ columns: [t.orgId, t.userId] }),
    unique("uq_email").on(t.email),
    check("age_check", sql`${t.age} >= 0`),
    index("members_email_idx").on(t.email),
  ]);
  const { statements } = generateSqliteUpStatements(
    createSchemaSnapshot({ dialect: "sqlite", tables: [members] }),
  );
  const create = statements.find((s) => s.startsWith("CREATE TABLE"))!;

  assert(create.includes('PRIMARY KEY ("orgId", "userId")'), create);
  assert(create.includes('CONSTRAINT "uq_email" UNIQUE ("email")'), create);
  assert(create.includes('CONSTRAINT "age_check" CHECK ("age" >= 0)'), create);
  assert(
    statements.includes(
      'CREATE INDEX "members_email_idx" ON "members" ("email");',
    ),
  );
});

Deno.test("parity: SQLite emits UNIQUE + inline FOREIGN KEY with actions", () => {
  const orgs = defineTable("orgs", { id: columns.integer().primaryKey() });
  const users = defineTable("users", {
    id: columns.integer().primaryKey(),
    email: columns.text().notNull().unique(),
    orgId: columns.integer().references("orgs", "id", { onDelete: "set null" }),
  });
  const { statements } = generateSqliteUpStatements(
    createSchemaSnapshot({ dialect: "sqlite", tables: [orgs, users] }),
  );
  const usersDdl = statements.find((statement) =>
    statement.includes('CREATE TABLE "users"')
  )!;

  // SQLite keeps both constraints inline in the CREATE TABLE.
  assert(usersDdl.includes('UNIQUE ("email")'), usersDdl);
  assert(
    usersDdl.includes(
      'FOREIGN KEY ("orgId") REFERENCES "orgs" ("id") ON DELETE SET NULL',
    ),
    usersDdl,
  );
});

Deno.test("parity: SQLite type affinity mapping", () => {
  assertEquals(generateSqliteColumnType({ kind: "integer" }), "INTEGER");
  assertEquals(generateSqliteColumnType({ kind: "boolean" }), "INTEGER");
  assertEquals(generateSqliteColumnType({ kind: "number" }), "REAL");
  assertEquals(generateSqliteColumnType({ kind: "text" }), "TEXT");
  assertEquals(generateSqliteColumnType({ kind: "uuid" }), "TEXT");
  assertEquals(generateSqliteColumnType({ kind: "blob" }), "BLOB");
  assertEquals(generateSqliteColumnType({ kind: "bytea" }), "BLOB");
  assertEquals(
    generateSqliteColumnType({ kind: "vector", dialectType: "vector(3)" }),
    "TEXT",
  );
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
