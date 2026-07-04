/**
 * Basic PostgreSQL-**family** example for Sisal.
 *
 * Generates the schema DDL with zero setup (prints it), then — if `DATABASE_URL`
 * is set — connects over the selected PostgreSQL-family driver and runs a tiny
 * CRUD (create, read, update, delete). The dialect + builder are shared and
 * `NeonDatabase` ≡ `PgDatabase`, so the same code runs over any driver; pick one
 * with `SISAL_ADAPTER`:
 *
 * - `"pg"` (default) — `@sisal/pg` on its default driver (postgres.js,
 *   `npm:postgres`, since v0.10).
 * - `"pg-db-postgres"` — `@sisal/pg` on the pure-JSR `jsr:@db/postgres`.
 * - `"neon"` — `@sisal/neon` over a WebSocket (set `NEON_WS_PROXY` for a local
 *   `neon-proxy`; omit for real Neon).
 *
 * ```sh
 * # just print the DDL (no database):
 * deno run --allow-read examples/postgres-family-basic/mod.ts
 * # connect + CRUD over a chosen driver:
 * DATABASE_URL=postgres://... SISAL_ADAPTER=neon \
 *   deno run --allow-env --allow-net --allow-read examples/postgres-family-basic/mod.ts
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
import { connect as connectPg, type PgDatabase } from "@sisal/pg";
import { connect as connectNeon } from "@sisal/neon";
import { generatePostgresUpStatements } from "@sisal/pg/ddl";

const users = defineTable("users", {
  id: columns.uuid().primaryKey(),
  email: columns.text().notNull().unique(),
  name: columns.text().notNull(),
  createdAt: columns.timestamp({ withTimezone: true, mode: "date" }).notNull(),
});

const snapshot = createSchemaSnapshot({ dialect: "postgres", tables: [users] });
const { statements } = generatePostgresUpStatements(snapshot);
console.log(statements.join("\n\n"));

const url = readEnv("DATABASE_URL");
if (url !== undefined) {
  const adapter = getAdapter();
  const db = await openDb(url, adapter);
  try {
    for (const statement of statements) await db.execute(statement);

    // CREATE — all values bind as parameters; nothing is string-interpolated.
    const id = crypto.randomUUID();
    await db.insert(users).values({
      id,
      email: "ada@example.com",
      name: "Ada Lovelace",
      createdAt: new Date(),
    }).execute();

    // READ — a typed select builder (row keys map back to the JS-side names).
    const found = await db.select({
      name: users.columns.name,
      email: users.columns.email,
    }).from(users).where(eq(users.columns.id, id)).execute();
    console.log(`\nselected: ${found[0]?.name} <${found[0]?.email}>`);

    // UPDATE — `.set(...)` with a where; RETURNING gives back the new row.
    const renamed = await db.update(users).set({ name: "Ada, Countess" })
      .where(eq(users.columns.id, id)).returning().execute();
    console.log(`updated:  ${renamed.rows[0]?.name}`);

    // DELETE — a where is required. `update`/`delete` with no `where` throw
    // unless you first call `.unsafeAllowAllRows()`; that safety rail is why
    // an accidental "delete everything" can't happen silently.
    await db.delete(users).where(eq(users.columns.id, id)).execute();

    const result = await db.query<{ count: number }>(
      sql`select count(*)::int as count from users`,
    );
    console.log(
      `users after delete: ${Number(result.rows[0].count)} (via ${adapter})`,
    );
  } finally {
    await db.close();
  }
}

/** Which PostgreSQL-family driver to connect with, from `SISAL_ADAPTER`. */
function getAdapter(): "pg" | "pg-db-postgres" | "neon" {
  const raw = (readEnv("SISAL_ADAPTER") ?? "pg").trim();
  if (raw === "pg" || raw === "pg-db-postgres" || raw === "neon") return raw;
  throw new Error(`Unknown SISAL_ADAPTER "${raw}".`);
}

async function openDb(
  url: string,
  adapter: "pg" | "pg-db-postgres" | "neon",
): Promise<PgDatabase> {
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
  if (adapter === "pg-db-postgres") {
    return await connectPg({ url, driver: "db-postgres" });
  }
  return await connectPg({ url });
}

/** Reads an environment variable, tolerating a missing `--allow-env`. */
function readEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}
