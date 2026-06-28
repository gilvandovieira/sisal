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
