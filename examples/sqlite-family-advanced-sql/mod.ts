/**
 * SQLite-family advanced SQL examples for Sisal.
 *
 * SQLite coverage is intentionally conservative. The live path probes feature
 * support before running optional JSON, window, recursive, generated-column, or
 * RETURNING cases; skipped paths are recorded as v0.8 roadmap pressure points.
 *
 * @module
 */

import { createSchemaSnapshot, type Database, type Sql, sql } from "@sisal/orm";
import {
  createLibsqlClient,
  createLibsqlDb,
  type LibsqlClient,
} from "@sisal/libsql";
import {
  createSqliteDb,
  generateSqliteUpStatements,
  openSqliteDatabase,
  type SqliteLikeDatabase,
} from "@sisal/sqlite";

import { schemaTables } from "./src/schema.ts";
import {
  advancedSqlCases,
  cleanupStatements,
  renderAdvancedSqlCases,
  seedStatements,
  type SqliteCapability,
} from "./src/statements.ts";

function section(title: string): void {
  console.log(`\n== ${title} ${"=".repeat(Math.max(0, 64 - title.length))}`);
}

export function printRendered(): void {
  section("SQLite-family advanced SQL render");
  for (const entry of renderAdvancedSqlCases()) {
    console.log(`\n-- ${entry.id} ${entry.title} [${entry.implementation}]`);
    if (entry.sql.length === 0) {
      console.log("-- skipped or not applicable in this conservative pass");
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

interface OpenedSqlite {
  readonly db: Database;
  readonly close: () => Promise<void> | void;
}

export async function runLive(): Promise<void> {
  section(`SQLite-family live smoke (${sqliteAdapter()})`);
  const opened = await openDb();
  try {
    await cleanup(opened.db);
    await createSchema(opened.db);
    await seed(opened.db);
    const capabilities = await probeCapabilities(opened.db);
    for (const entry of advancedSqlCases(opened.db)) {
      if (!entry.live) continue;
      if (
        entry.requires !== undefined &&
        capabilities[entry.requires] !== true
      ) {
        console.log(
          `skip ${entry.id} ${entry.title}: missing ${entry.requires}`,
        );
        continue;
      }
      for (const statement of entry.statements) {
        await opened.db.execute(statement);
      }
      console.log(`ok ${entry.id} ${entry.title}`);
    }
  } finally {
    await cleanup(opened.db);
    await opened.close();
  }
}

async function createSchema(db: Database): Promise<void> {
  const ddl = generateSqliteUpStatements(
    createSchemaSnapshot({ dialect: "sqlite", tables: schemaTables }),
  );
  for (const statement of ddl.statements) {
    await db.execute(statement);
  }
}

async function seed(db: Database): Promise<void> {
  for (const statement of seedStatements) {
    await db.execute(statement);
  }
}

async function cleanup(db: Database): Promise<void> {
  for (const statement of cleanupStatements) {
    await db.execute(statement);
  }
}

type CapabilityMap = Record<SqliteCapability, boolean>;

async function probeCapabilities(db: Database): Promise<CapabilityMap> {
  return {
    window: await probe(db, sql`select row_number() over () as rn`),
    recursive: await probe(
      db,
      sql`
      with recursive seq(x) as (
        select 1 union all select x + 1 from seq where x < 1
      )
      select x from seq
    `,
    ),
    json: await probe(
      db,
      sql`select json_extract(${'{"a":1}'}, '$.a') as a`,
    ),
    generated: await probe(
      db,
      sql`
      create temp table sisal_adv_generated_probe (
        payload text,
        title text generated always as (json_extract(payload, '$.title')) stored
      )
    `,
    ),
    returning: await probe(
      db,
      sql`
      update sisal_adv_jobs
      set status = status
      where 1 = 0
      returning id
    `,
    ),
  };
}

async function probe(db: Database, statement: Sql): Promise<boolean> {
  try {
    await db.execute(statement);
    return true;
  } catch {
    return false;
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

function sqliteAdapter(): "sqlite" | "libsql" {
  const rawAdapter = (readEnv("SISAL_ADAPTER") ?? "sqlite").trim();
  if (rawAdapter === "sqlite" || rawAdapter === "libsql") return rawAdapter;
  throw new Error(
    `Unknown SISAL_ADAPTER "${rawAdapter}"; use "sqlite" or "libsql".`,
  );
}

async function openDb(): Promise<OpenedSqlite> {
  if (sqliteAdapter() === "libsql") {
    const url = readEnv("TURSO_DATABASE_URL") ??
      readEnv("SISAL_LIBSQL_URL") ?? "file:./sisal-advanced-sql.sqlite";
    const authToken = readEnv("TURSO_AUTH_TOKEN");
    const client: LibsqlClient = await createLibsqlClient(
      authToken === undefined ? { url } : { url, authToken },
    );
    const db = await createLibsqlDb({ client });
    return { db, close: () => client.close?.() };
  }
  const handle: SqliteLikeDatabase = await openSqliteDatabase({
    path: readEnv("SISAL_SQLITE_PATH") ?? ":memory:",
  });
  const db = await createSqliteDb({ database: handle });
  return { db, close: () => handle.close() };
}

export function renderedForTests() {
  return renderAdvancedSqlCases();
}

if (import.meta.main) {
  printRendered();
  if (readEnv("SISAL_SQLITE_ADVANCED_SQL_IT") === "1") {
    await runLive();
  } else {
    console.log(
      "\n(Set SISAL_SQLITE_ADVANCED_SQL_IT=1 to execute the SQLite smoke run; " +
        "SISAL_ADAPTER=sqlite|libsql selects the driver.)",
    );
  }
}
