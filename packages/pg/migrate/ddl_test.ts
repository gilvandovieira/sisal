import { assertEquals, assertThrows } from "@std/assert";
import { OrmError, type SisalSchemaSnapshot } from "@sisal/orm";
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

Deno.test("@sisal/pg - emits a STORED generated column", () => {
  const docs: SisalSchemaSnapshot["tables"][number] = {
    name: "docs",
    columns: [
      { name: "id", type: { kind: "integer" }, nullable: false },
      { name: "payload", type: { kind: "jsonb" }, nullable: false },
      {
        name: "title",
        type: { kind: "text" },
        generatedAs: { sql: "payload ->> 'title'", stored: true },
      },
    ],
    primaryKey: { columns: ["id"] },
  };
  assertEquals(
    generatePostgresCreateTable(docs),
    'CREATE TABLE "docs" (\n' +
      '  "id" integer NOT NULL,\n' +
      '  "payload" jsonb NOT NULL,\n' +
      `  "title" text GENERATED ALWAYS AS (payload ->> 'title') STORED,\n` +
      '  PRIMARY KEY ("id")\n' +
      ");",
  );
});

Deno.test("@sisal/pg - rejects a VIRTUAL generated column (typed)", () => {
  const docs: SisalSchemaSnapshot["tables"][number] = {
    name: "docs",
    columns: [
      { name: "id", type: { kind: "integer" }, nullable: false },
      {
        name: "v",
        type: { kind: "integer" },
        generatedAs: { sql: "id + 1", stored: false },
      },
    ],
    primaryKey: { columns: ["id"] },
  };
  const error = assertThrows(
    () => generatePostgresCreateTable(docs),
    OrmError,
    "VIRTUAL",
  );
  assertEquals((error as OrmError).code, "ORM_DIALECT_UNSUPPORTED");
});

Deno.test("@sisal/pg - emits schema objects after table creation", () => {
  const fn = "CREATE FUNCTION touch() RETURNS trigger AS $$ BEGIN " +
    "NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;";
  const to: SisalSchemaSnapshot = {
    version: 2,
    tables: [users],
    schemaObjects: [
      { name: "touch", kind: "function", dialect: "postgres", up: fn },
      // A sqlite-only object must be skipped by the Postgres generator.
      {
        name: "sqlite_only",
        kind: "trigger",
        dialect: "sqlite",
        up: "CREATE TRIGGER t AFTER INSERT ON users BEGIN SELECT 1; END;",
      },
    ],
  };

  const plan = generatePostgresUpStatements(to);

  // The function trails the CREATE TABLE; the sqlite-only object is gated out.
  assertEquals(plan.statements[0].startsWith('CREATE TABLE "users"'), true);
  assertEquals(plan.statements[plan.statements.length - 1], fn);
  assertEquals(plan.statements.filter((s) => s.includes("CREATE TRIGGER")), []);
});

Deno.test("@sisal/pg - does not re-emit unchanged schema objects", () => {
  const fn = "CREATE FUNCTION touch() RETURNS trigger AS $$ BEGIN " +
    "RETURN NEW; END; $$ LANGUAGE plpgsql;";
  const object = {
    name: "touch",
    kind: "function" as const,
    dialect: "postgres" as const,
    up: fn,
  };
  const snapshot: SisalSchemaSnapshot = {
    version: 2,
    tables: [users],
    schemaObjects: [object],
  };

  // from === to for the object → nothing to apply for it.
  const plan = generatePostgresUpStatements(snapshot, snapshot);

  assertEquals(plan.statements.includes(fn), false);
});
