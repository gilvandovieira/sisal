import { assertEquals } from "@std/assert";
import type { SisalSchemaSnapshot } from "@sisal/orm";
import {
  generatePostgresCreateTable,
  generatePostgresUpStatements,
} from "./ddl.ts";

const users: SisalSchemaSnapshot["tables"][number] = {
  name: "users",
  columns: [
    { name: "id", type: { kind: "uuid" }, nullable: false },
    { name: "email", type: { kind: "varchar", length: 320 } },
  ],
  primaryKey: { columns: ["id"] },
};

Deno.test("@sisal/pg - generates PostgreSQL CREATE TABLE SQL", () => {
  assertEquals(
    generatePostgresCreateTable(users),
    'CREATE TABLE "users" (\n' +
      '  "id" uuid NOT NULL,\n' +
      '  "email" varchar(320),\n' +
      '  PRIMARY KEY ("id")\n' +
      ");",
  );
});

Deno.test("@sisal/pg - generates additive PostgreSQL migration SQL", () => {
  const from: SisalSchemaSnapshot = {
    version: 2,
    tables: [{
      name: "users",
      columns: [{ name: "id", type: { kind: "uuid" }, nullable: false }],
    }],
  };
  const to: SisalSchemaSnapshot = {
    version: 2,
    tables: [users],
  };

  const plan = generatePostgresUpStatements(to, from);

  assertEquals(plan.destructive, []);
  assertEquals(plan.statements, [
    'ALTER TABLE "users" ADD COLUMN "email" varchar(320);',
  ]);
});
