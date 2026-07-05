/**
 * Basic MySQL-**family** example for Sisal.
 *
 * Generates the schema DDL with zero setup (prints it), then — if `MYSQL_URL`,
 * `MARIADB_URL`, or `DATABASE_URL` is set — connects over the selected
 * MySQL-family driver and runs a tiny CRUD (create, read, update, delete). The
 * dialect + builder are shared by MySQL and MariaDB; pick a driver with
 * `SISAL_ADAPTER`:
 *
 * - `"mysql2"` (default) — `@sisal/mysql` on `npm:mysql2`.
 * - `"mariadb"` — `@sisal/mysql` on the MariaDB Connector/Node.js.
 *
 * ```sh
 * # just print the DDL (no database):
 * deno run --allow-read examples/mysql-family-basic/mod.ts
 * # connect + CRUD over a chosen driver:
 * MYSQL_URL=mysql://root:root@localhost:33084/sisal SISAL_ADAPTER=mariadb \
 *   deno run --allow-env --allow-net --allow-read examples/mysql-family-basic/mod.ts
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
import {
  connect,
  generateMysqlUpStatements,
  type MysqlDatabase,
  type MysqlDriverKind,
} from "@sisal/mysql";

const users = defineTable("sisal_basic_users", {
  id: columns.serial().primaryKey(),
  email: columns.varchar(255).notNull().unique(),
  name: columns.varchar(120).notNull(),
  active: columns.boolean().notNull().default(true),
});

const snapshot = createSchemaSnapshot({ dialect: "mysql", tables: [users] });
const { statements } = generateMysqlUpStatements(snapshot);
console.log(statements.join("\n\n"));

const url = readEnv("MYSQL_URL") ?? readEnv("MARIADB_URL") ??
  readEnv("DATABASE_URL");
if (url !== undefined) {
  const adapter = getAdapter();
  const db = await openDb(url, adapter);
  try {
    for (const statement of statements) await db.execute(statement);

    // CREATE — values bind as parameters (`?` placeholders on MySQL).
    await db.insert(users).values({
      email: "ada@example.com",
      name: "Ada Lovelace",
    }).execute();

    // READ — MySQL proper has no `INSERT ... RETURNING`, so we read the
    // serial id back with a typed select on the unique email.
    const found = await db.select({
      id: users.columns.id,
      name: users.columns.name,
    }).from(users).where(eq(users.columns.email, "ada@example.com")).execute();
    console.log(`\nselected: #${found[0]?.id} ${found[0]?.name}`);

    // UPDATE — no RETURNING on base MySQL either, so read back after.
    await db.update(users).set({ name: "Ada, Countess" })
      .where(eq(users.columns.email, "ada@example.com")).execute();

    // DELETE — a where is required. `update`/`delete` with no `where` throw
    // unless you first call `.unsafeAllowAllRows()` (the mass-mutation rail).
    await db.delete(users).where(eq(users.columns.email, "ada@example.com"))
      .execute();

    const result = await db.query<{ count: number }>(
      sql`select count(*) as count from sisal_basic_users`,
    );
    console.log(
      `users after delete: ${Number(result.rows[0].count)} (via ${adapter})`,
    );
  } finally {
    await db.close();
  }
}

/** Which MySQL-family driver to connect with, from `SISAL_ADAPTER`. */
function getAdapter(): MysqlDriverKind {
  const raw = (readEnv("SISAL_ADAPTER") ?? "mysql2").trim();
  if (raw === "mysql2" || raw === "mariadb") return raw;
  throw new Error(
    `Unknown SISAL_ADAPTER "${raw}"; use "mysql2" or "mariadb".`,
  );
}

function openDb(url: string, adapter: MysqlDriverKind): Promise<MysqlDatabase> {
  return connect({ url, driver: adapter });
}

/** Reads an environment variable, tolerating a missing `--allow-env`. */
function readEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}
