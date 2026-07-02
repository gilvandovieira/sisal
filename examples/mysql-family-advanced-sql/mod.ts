/**
 * MySQL-family advanced SQL examples for Sisal.
 *
 * This package exercises the advanced SQL contracts on MySQL 8 and MariaDB.
 * Builder-native cases stay builder native, while missing Sisal primitives use
 * parameterized raw SQL and are recorded as v0.8 roadmap pressure points.
 *
 * @module
 */

import { createSchemaSnapshot, type Database } from "@sisal/orm";
import {
  connect,
  generateMysqlUpStatements,
  type MysqlDatabase,
  type MysqlDriverKind,
} from "@sisal/mysql";

import { schemaTables } from "./src/schema.ts";
import {
  advancedSqlCases,
  cleanupStatements,
  documentDdl,
  renderAdvancedSqlCases,
  seedStatements,
} from "./src/statements.ts";

function section(title: string): void {
  console.log(`\n== ${title} ${"=".repeat(Math.max(0, 64 - title.length))}`);
}

export function printRendered(): void {
  section("MySQL-family advanced SQL render");
  for (const entry of renderAdvancedSqlCases()) {
    console.log(`\n-- ${entry.id} ${entry.title} [${entry.implementation}]`);
    for (const text of entry.sql) {
      console.log(`${text.trim()};`);
    }
    for (const params of entry.params) {
      if (params.length > 0) {
        console.log(`-- params: ${JSON.stringify(params)}`);
      }
    }
    for (const error of entry.errors) {
      console.log(`-- typed guard: ${error}`);
    }
  }
}

export async function runLive(url: string): Promise<void> {
  const driver = mysqlAdapter();
  section(`MySQL-family live smoke (${driver})`);
  const db = await connect({ url, driver });
  try {
    await cleanup(db);
    await createSchema(db);
    await seed(db);
    for (const entry of advancedSqlCases(db)) {
      if (!entry.live) continue;
      for (const statement of entry.statements) {
        await db.execute(statement);
      }
      console.log(`ok ${entry.id} ${entry.title}`);
    }
  } finally {
    await cleanup(db);
    await db.close();
  }
}

async function createSchema(db: Database): Promise<void> {
  const ddl = generateMysqlUpStatements(
    createSchemaSnapshot({ dialect: "mysql", tables: schemaTables }),
  );
  for (const statement of ddl.statements) {
    await db.execute(statement);
  }
  for (const statement of documentDdl()) {
    await db.execute(statement);
  }
}

async function seed(db: Database): Promise<void> {
  for (const statement of seedStatements) {
    await db.execute(statement);
  }
}

async function cleanup(db: MysqlDatabase): Promise<void> {
  for (const statement of cleanupStatements) {
    await db.execute(statement);
  }
}

function readEnv(name: string): string | undefined {
  try {
    return (globalThis as {
      Deno?: { env: { get(key: string): string | undefined } };
    }).Deno?.env.get(name);
  } catch {
    return undefined;
  }
}

function databaseUrl(): string | undefined {
  return readEnv("MYSQL_URL") ?? readEnv("MARIADB_URL") ??
    readEnv("DATABASE_URL");
}

function mysqlAdapter(): MysqlDriverKind {
  const rawAdapter = (readEnv("SISAL_ADAPTER") ?? "mysql2").trim();
  if (rawAdapter === "mysql2" || rawAdapter === "mariadb") return rawAdapter;
  throw new Error(
    `Unknown SISAL_ADAPTER "${rawAdapter}"; use "mysql2" or "mariadb".`,
  );
}

export function renderedForTests() {
  return renderAdvancedSqlCases();
}

if (import.meta.main) {
  printRendered();
  const url = databaseUrl();
  if (url === undefined) {
    console.log(
      "\n(Set MYSQL_URL, MARIADB_URL, or DATABASE_URL to execute the smoke " +
        "run; SISAL_ADAPTER=mysql2|mariadb selects the driver.)",
    );
  } else {
    await runLive(url);
  }
}
