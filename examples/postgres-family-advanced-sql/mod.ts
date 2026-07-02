/**
 * PostgreSQL-family advanced SQL examples for Sisal.
 *
 * This package graduates the Markdown-only advanced SQL contracts into a
 * runnable, workspace-checked example. Builder-native cases stay builder
 * native; engine-supported cases without a Sisal primitive use the
 * parameterized `sql` template and are logged as v0.8 roadmap pain points.
 *
 * @module
 */

import { createSchemaSnapshot, type Database, renderSql } from "@sisal/orm";
import { connect as connectNeon } from "@sisal/neon";
import { connect as connectPg, generatePostgresUpStatements } from "@sisal/pg";
import type { PgDatabase } from "@sisal/pg";

import {
  advancedSqlCases,
  cleanupStatements,
  documentDdl,
  renderAdvancedSqlCases,
  seedStatements,
} from "./src/statements.ts";
import { schemaTables } from "./src/schema.ts";

function section(title: string): void {
  console.log(`\n== ${title} ${"=".repeat(Math.max(0, 64 - title.length))}`);
}

export function printRendered(): void {
  section("PostgreSQL-family advanced SQL render");
  for (const entry of renderAdvancedSqlCases()) {
    console.log(`\n-- ${entry.id} ${entry.title} [${entry.implementation}]`);
    if (entry.sql.length === 0) {
      console.log("-- covered by sibling dialect example");
      continue;
    }
    entry.sql.forEach((text, index) => {
      console.log(`${text.trim()};`);
      const params = entry.params[index] ?? [];
      if (params.length > 0) {
        console.log(`-- params: ${JSON.stringify(params)}`);
      }
    });
  }
}

class Rollback extends Error {}

function isRollback(error: unknown): boolean {
  for (
    let current: unknown = error;
    current instanceof Error;
    current = current.cause
  ) {
    if (current instanceof Rollback) return true;
  }
  return false;
}

export async function runLive(url: string): Promise<void> {
  section(`PostgreSQL-family live smoke (${pgAdapter()})`);
  const db = await openDb(url);
  try {
    await db.transaction(async (tx) => {
      await createSchema(tx);
      await seed(tx);
      for (const entry of advancedSqlCases(tx)) {
        if (!entry.live) continue;
        for (const statement of entry.statements) {
          await tx.execute(statement);
        }
        console.log(`ok ${entry.id} ${entry.title}`);
      }
      throw new Rollback();
    });
  } catch (error) {
    if (!isRollback(error)) throw error;
    console.log("transaction rolled back; database left untouched.");
  } finally {
    await db.close();
  }
}

async function createSchema(db: Database): Promise<void> {
  const ddl = generatePostgresUpStatements(
    createSchemaSnapshot({ dialect: "postgres", tables: schemaTables }),
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
  return readEnv("DATABASE_URL");
}

function pgAdapter(): "pg" | "pg-postgres-js" | "neon" {
  const rawAdapter = (readEnv("SISAL_ADAPTER") ?? "pg").trim();
  if (
    rawAdapter === "pg" || rawAdapter === "pg-postgres-js" ||
    rawAdapter === "neon"
  ) {
    return rawAdapter;
  }
  throw new Error(
    `Unknown SISAL_ADAPTER "${rawAdapter}"; use "pg", "pg-postgres-js", or "neon".`,
  );
}

async function openDb(url: string): Promise<PgDatabase> {
  const adapter = pgAdapter();
  if (adapter === "neon") {
    const wsProxy = readEnv("NEON_WS_PROXY");
    if (wsProxy !== undefined) {
      const mod = await import("@neon/serverless");
      const cfg = (mod as unknown as { neonConfig: Record<string, unknown> })
        .neonConfig;
      cfg.wsProxy = () => `${wsProxy}/v1`;
      cfg.useSecureWebSocket = false;
      cfg.pipelineTLS = false;
      cfg.pipelineConnect = false;
    }
    return await connectNeon({ url });
  }
  if (adapter === "pg-postgres-js") {
    return await connectPg({ url, driver: "postgres-js" });
  }
  return await connectPg({ url });
}

export function renderedForTests() {
  return renderAdvancedSqlCases();
}

export function renderOneForTests(index: number): string {
  const entry = advancedSqlCases()[index];
  return entry.statements.map((statement) =>
    renderSql(statement, { dialect: "postgres" }).text
  ).join("\n");
}

if (import.meta.main) {
  printRendered();
  const url = databaseUrl();
  if (url === undefined) {
    console.log(
      "\n(Set DATABASE_URL to execute the smoke run; " +
        "SISAL_ADAPTER=pg|pg-postgres-js|neon selects the driver.)",
    );
  } else {
    await runLive(url);
  }
}

// Keep the cleanup list referenced so check/lint pins it for future DB tests.
void cleanupStatements;
