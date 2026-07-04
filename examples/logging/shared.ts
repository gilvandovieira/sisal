import {
  columns,
  createDatabase,
  defineTable,
  eq,
  type Logger,
  memoryOrmDriver,
  type SisalSqlLogSettings,
} from "@sisal/orm";

const users = defineTable("users", {
  id: columns.integer().primaryKey(),
  email: columns.text().notNull(),
  apiToken: columns.text(),
});

/**
 * Runs a tiny workload through a logged `Database` so the injected `Logger`
 * receives Sisal's structured SQL/result events. `memoryOrmDriver()` stands in
 * for a real adapter, so this needs no database and no network.
 *
 * The point is the **safe posture**: Sisal logs SQL text and result shapes, but
 * bind parameters are only ever emitted as redacted summaries — never raw
 * string, binary, date, or object values. A value that looks like a secret is
 * flagged, not printed. Pass `parameters: "off"` to omit even the safe
 * summaries when a workload must not leak parameter cardinality at all.
 */
export async function runSisalLoggingDemo(
  logger: Logger,
  sql: SisalSqlLogSettings = { parameters: "redacted" },
): Promise<void> {
  const db = createDatabase({
    dialect: "postgres",
    driver: memoryOrmDriver(),
    logging: {
      logger,
      level: "trace",
      // Per-category control (Hibernate-style): here, keep SQL + bind events
      // but silence per-row result logging.
      categories: { "orm.result": "info" },
      sql,
    },
  });

  try {
    // A parameter that looks like a secret: with `"redacted"` the log shows a
    // length + secret-detected flag, never the value; with `"off"` nothing.
    await db.select()
      .from(users)
      .where(eq(users.columns.email, "password=swordfish"))
      .execute();

    // Object/token bind values are summarized to a redacted key list / length,
    // so tokens never reach the log sink.
    await db.insert(users)
      .values({ id: 1, email: "ada@example.com", apiToken: "sk-live-abcdef" })
      .execute();
  } finally {
    await db.close();
  }
}
