import { assertEquals } from "@std/assert";
import type { SisalSchemaSnapshot } from "@sisal/orm";
import {
  generateSqliteCreateTable,
  generateSqliteUpStatements,
} from "./ddl.ts";

const notes: SisalSchemaSnapshot["tables"][number] = {
  name: "notes",
  columns: [
    { name: "id", type: { kind: "text" }, nullable: false },
    {
      name: "archived",
      type: { kind: "boolean" },
      default: { kind: "literal", value: false },
    },
  ],
  primaryKey: { columns: ["id"] },
};

Deno.test("@sisal/sqlite - generates SQLite CREATE TABLE SQL", () => {
  assertEquals(
    generateSqliteCreateTable(notes),
    'CREATE TABLE "notes" (\n' +
      '  "id" TEXT NOT NULL,\n' +
      '  "archived" INTEGER DEFAULT 0,\n' +
      '  PRIMARY KEY ("id")\n' +
      ");",
  );
});

Deno.test("@sisal/sqlite - generates additive SQLite migration SQL", () => {
  const from: SisalSchemaSnapshot = {
    version: 2,
    tables: [{
      name: "notes",
      columns: [{ name: "id", type: { kind: "text" }, nullable: false }],
    }],
  };
  const to: SisalSchemaSnapshot = {
    version: 2,
    tables: [notes],
  };

  const plan = generateSqliteUpStatements(to, from);

  assertEquals(plan.destructive, []);
  assertEquals(plan.statements, [
    'ALTER TABLE "notes" ADD COLUMN "archived" INTEGER DEFAULT 0;',
  ]);
});

Deno.test("@sisal/sqlite - emits schema objects after table creation", () => {
  const trigger = "CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN " +
    "SELECT 1; END;";
  const to: SisalSchemaSnapshot = {
    version: 2,
    tables: [notes],
    schemaObjects: [
      { name: "notes_ai", kind: "trigger", dialect: "sqlite", up: trigger },
      // A postgres-only object must be skipped by the SQLite generator.
      {
        name: "pg_only",
        kind: "function",
        dialect: "postgres",
        up: "CREATE FUNCTION f() RETURNS void AS $$ $$ LANGUAGE sql;",
      },
    ],
  };

  const plan = generateSqliteUpStatements(to);

  assertEquals(plan.statements[0].startsWith('CREATE TABLE "notes"'), true);
  assertEquals(plan.statements[plan.statements.length - 1], trigger);
  assertEquals(
    plan.statements.filter((s) => s.includes("CREATE FUNCTION")),
    [],
  );
});

Deno.test("@sisal/sqlite - dialect-agnostic schema objects emit", () => {
  const view = "CREATE VIEW active AS SELECT * FROM notes WHERE archived = 0;";
  const to: SisalSchemaSnapshot = {
    version: 2,
    tables: [notes],
    // No `dialect` → emitted for every dialect, including sqlite/libsql.
    schemaObjects: [{ name: "active", kind: "view", up: view }],
  };

  const plan = generateSqliteUpStatements(to);

  assertEquals(plan.statements[plan.statements.length - 1], view);
});
