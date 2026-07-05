// End-to-end check of a built @sisaljs/* adapter running on Node against a real
// database. Driven by env: ADAPTER (pg|neon|mysql|mariadb|sqlite|libsql) and
// DB_URL. Exercises DDL + INSERT/SELECT/UPDATE/aggregate/transaction-rollback/
// DELETE through the ORM, with no RETURNING dependency so it is dialect-neutral.
//
// Run via tools/npm_e2e/run.sh, which builds the npm packages, links them into
// a consumer project, and invokes this for each adapter. See
// docs/npm-distribution-plan.md (Phase 7 verification).
import {
  columns,
  createSchemaSnapshot,
  defineTable,
  eq,
  sql,
} from "@sisaljs/orm";

const ADAPTER = process.env.ADAPTER;
const URL = process.env.DB_URL;

const specs = {
  pg: {
    mod: "@sisaljs/pg",
    ddl: "@sisaljs/pg/ddl",
    gen: "generatePostgresUpStatements",
    dialect: "postgres",
    opts: { url: URL },
  },
  neon: {
    mod: "@sisaljs/neon",
    ddl: "@sisaljs/neon/ddl",
    gen: "generatePostgresUpStatements",
    dialect: "postgres",
    opts: { connectionString: URL },
  },
  mysql: {
    mod: "@sisaljs/mysql",
    ddl: "@sisaljs/mysql/ddl",
    gen: "generateMysqlUpStatements",
    dialect: "mysql",
    opts: { url: URL },
  },
  mariadb: {
    mod: "@sisaljs/mysql",
    ddl: "@sisaljs/mysql/ddl",
    gen: "generateMysqlUpStatements",
    dialect: "mysql",
    opts: { url: URL, driver: "mariadb" },
  },
  sqlite: {
    mod: "@sisaljs/sqlite",
    ddl: "@sisaljs/sqlite/ddl",
    gen: "generateSqliteUpStatements",
    dialect: "sqlite",
    opts: { path: URL || ":memory:" },
  },
  libsql: {
    mod: "@sisaljs/libsql",
    ddl: "@sisaljs/libsql/ddl",
    gen: "generateLibsqlUpStatements",
    dialect: "sqlite",
    opts: { url: URL },
  },
};

const s = specs[ADAPTER];
if (!s) throw new Error(`unknown ADAPTER "${ADAPTER}"`);

// Neon speaks Postgres over a WebSocket; point its driver at the local wsproxy.
if (ADAPTER === "neon" && process.env.NEON_WS_PROXY) {
  const neon = await import("@neondatabase/serverless");
  const cfg = neon.neonConfig;
  cfg.wsProxy = () => `${process.env.NEON_WS_PROXY}/v1`;
  cfg.useSecureWebSocket = false;
  cfg.pipelineTLS = false;
  cfg.pipelineConnect = false;
}

const { connect } = await import(s.mod);
const genUp = (await import(s.ddl))[s.gen];

const items = defineTable("e2e_items", {
  id: columns.integer().primaryKey(),
  name: columns.text().notNull(),
  score: columns.integer().notNull().default(0),
  active: columns.boolean().notNull().default(false),
});

const { statements } = genUp(
  createSchemaSnapshot({ dialect: s.dialect, tables: [items] }),
);
const db = await connect(s.opts);
const row = (result) => result.rows?.[0] ?? result[0];

try {
  await db.execute(`drop table if exists e2e_items`);
  for (const statement of statements) await db.execute(statement);

  await db.insert(items).values([
    { id: 1, name: "alpha", score: 10, active: true },
    { id: 2, name: "beta", score: 20, active: false },
    { id: 3, name: "gamma", score: 30, active: true },
  ]).execute();

  const selected = await db.select({ name: items.columns.name })
    .from(items).where(eq(items.columns.id, 1)).execute();

  await db.update(items).set({ score: 99 })
    .where(eq(items.columns.id, 2)).execute();
  const updated = await db.select({ score: items.columns.score })
    .from(items).where(eq(items.columns.id, 2)).execute();

  const agg = await db.query(
    sql`select count(*) as c, sum(score) as s from e2e_items`,
  );

  try {
    await db.transaction(async (tx) => {
      await tx.insert(items).values({ id: 4, name: "delta" }).execute();
      throw new Error("rollback");
    });
  } catch { /* expected rollback */ }
  const afterRollback = await db.query(sql`select count(*) as c from e2e_items`);

  await db.delete(items).where(eq(items.columns.id, 3)).execute();
  const finalCount = await db.query(sql`select count(*) as c from e2e_items`);

  const checks = [
    [selected[0]?.name === "alpha", "insert+select"],
    [Number(updated[0]?.score) === 99, "update"],
    [Number(row(agg).c) === 3 && Number(row(agg).s) === 139, "aggregate"],
    [Number(row(afterRollback).c) === 3, "transaction rollback"],
    [Number(row(finalCount).c) === 2, "delete"],
  ];
  const failed = checks.filter(([ok]) => !ok).map(([, name]) => name);
  if (failed.length > 0) {
    throw new Error(`[${ADAPTER}] FAILED checks: ${failed.join(", ")}`);
  }
  console.log(`[${ADAPTER}] E2E OK — ${checks.map(([, n]) => n).join(", ")}`);
} finally {
  await db.close();
}
