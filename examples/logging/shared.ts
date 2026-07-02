import {
  columns,
  createDatabase,
  defineTable,
  eq,
  type Logger,
  memoryOrmDriver,
} from "@sisal/orm";

const users = defineTable("users", {
  id: columns.integer().primaryKey(),
  email: columns.text().notNull(),
});

export async function runSisalLoggingDemo(logger: Logger): Promise<void> {
  const db = createDatabase({
    dialect: "postgres",
    driver: memoryOrmDriver(),
    logging: {
      logger,
      level: "trace",
      sql: { parameters: "redacted" },
    },
  });

  try {
    await db.select()
      .from(users)
      .where(eq(users.columns.email, "password=swordfish"))
      .execute();
  } finally {
    await db.close();
  }
}
