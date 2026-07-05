/**
 * Basic SQLite-**family** example for Sisal.
 *
 * Generates the schema DDL, then connects over the selected SQLite-family driver
 * and runs a tiny CRUD (create, read, update, delete). The dialect + builder are
 * shared and `SqliteDatabase` ≡ `LibsqlDatabase`, so the same code runs over
 * both; pick one with `SISAL_ADAPTER`:
 *
 * - `"sqlite"` (default) — embedded `@sisal/sqlite` over `@db/sqlite`; an
 *   in-memory database by default (set `SISAL_SQLITE_PATH` for a file).
 * - `"libsql"` — `@sisal/libsql`; a local `file:` by default (set
 *   `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` for Turso).
 *
 * ```sh
 * deno run -A examples/sqlite-family-basic/mod.ts                  # embedded sqlite
 * SISAL_ADAPTER=libsql deno run -A examples/sqlite-family-basic/mod.ts
 * ```
 *
 * @module
 */

import {
  columns,
  createSchemaSnapshot,
  defineTable,
  eq,
  sql,
} from "@sisal/orm";
import { connect as connectSqlite, type SqliteDatabase } from "@sisal/sqlite";
import { connect as connectLibsql } from "@sisal/libsql";
import { generateSqliteUpStatements } from "@sisal/sqlite/ddl";

const notes = defineTable("notes", {
  id: columns.text().primaryKey(),
  title: columns.text().notNull(),
  archived: columns.boolean().default(false),
});

const snapshot = createSchemaSnapshot({ dialect: "sqlite", tables: [notes] });
const { statements } = generateSqliteUpStatements(snapshot);
console.log(statements.join("\n\n"));

const adapter = getAdapter();
const db = await openDb(adapter);
try {
  for (const statement of statements) await db.execute(statement);

  // CREATE — values bind as parameters; `archived` uses its column default.
  const id = crypto.randomUUID();
  await db.insert(notes).values({ id, title: "SQLite-family note" }).execute();

  // READ — a typed select builder.
  const found = await db.select({ title: notes.columns.title })
    .from(notes).where(eq(notes.columns.id, id)).execute();
  console.log(`\nselected: ${found[0]?.title}`);

  // UPDATE — booleans round-trip as 0/1 on SQLite; RETURNING gives the new row.
  const archived = await db.update(notes).set({ archived: true })
    .where(eq(notes.columns.id, id)).returning().execute();
  console.log(`updated archived → ${archived.rows[0]?.archived}`);

  // DELETE — a where is required. `update`/`delete` with no `where` throw
  // unless you first call `.unsafeAllowAllRows()` (the mass-mutation rail).
  await db.delete(notes).where(eq(notes.columns.id, id)).execute();

  const result = await db.query<{ count: number }>(
    sql`select count(*) as count from notes`,
  );
  console.log(
    `notes after delete: ${Number(result.rows[0].count)} (via ${adapter})`,
  );
} finally {
  await db.close();
}

/** Which SQLite-family driver to connect with, from `SISAL_ADAPTER`. */
function getAdapter(): "sqlite" | "libsql" {
  const raw = (readEnv("SISAL_ADAPTER") ?? "sqlite").trim();
  if (raw === "sqlite" || raw === "libsql") return raw;
  throw new Error(`Unknown SISAL_ADAPTER "${raw}"; use "sqlite" or "libsql".`);
}

function openDb(adapter: "sqlite" | "libsql"): Promise<SqliteDatabase> {
  if (adapter === "libsql") {
    const url = readEnv("TURSO_DATABASE_URL") ??
      readEnv("SISAL_LIBSQL_URL") ?? "file:./sisal-basic.db";
    const authToken = readEnv("TURSO_AUTH_TOKEN");
    // `LibsqlDatabase` is structurally identical to `SqliteDatabase`.
    return connectLibsql(
      authToken === undefined ? { url } : { url, authToken },
    );
  }
  return connectSqlite({ path: readEnv("SISAL_SQLITE_PATH") ?? ":memory:" });
}

/** Reads an environment variable, tolerating a missing `--allow-env`. */
function readEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}
