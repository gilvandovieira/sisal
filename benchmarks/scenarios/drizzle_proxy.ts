/**
 * Drizzle ORM benchmark scenarios backed by the fake database proxy.
 *
 * @module
 */

import { eq, sql as drizzleSql } from "drizzle-orm";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pg-proxy";

import type { BenchmarkScenario } from "../harness.ts";
import { createFakeDbProxy, type FakeDbProxy } from "../fakedbproxy.ts";

const GROUP = "drizzle pg proxy";

const users = pgTable("users", {
  id: integer("id").primaryKey(),
  email: text("email").notNull(),
});

const proxy = createFakeDbProxy({
  rows: [
    { id: 1, email: "ada@example.com" },
    { id: 2, email: "grace@example.com" },
  ],
});

const db = drizzle(proxy.asDrizzlePgProxy({
  columns: ["id", "email"],
}));

export const drizzleProxyScenarios: readonly BenchmarkScenario[] = [
  {
    group: GROUP,
    name: "drizzle select via fake pg proxy",
    baseline: true,
    async fn() {
      proxy.reset();
      const rows = await db.select({
        id: users.id,
        email: users.email,
      }).from(users).where(eq(users.id, 1));

      if (rows.length !== 2 || rows[0]?.email !== "ada@example.com") {
        throw new Error("Drizzle fake proxy select returned unexpected rows.");
      }
      assertStats(proxy, { queries: 1 });
    },
  },
  {
    group: GROUP,
    name: "drizzle raw execute via fake pg proxy",
    async fn() {
      proxy.reset();
      const rows = await db.execute(
        drizzleSql`update ${users} set ${users.email} = ${"ada@lovelace.test"} where ${users.id} = ${1}`,
      );

      if (rows.length !== 0) {
        throw new Error("Drizzle fake proxy execute returned rows.");
      }
      assertStats(proxy, { executes: 1 });
    },
  },
  {
    group: GROUP,
    name: "drizzle insert returning via fake pg proxy",
    async fn() {
      proxy.reset();
      const rows = await db.insert(users).values({
        id: 3,
        email: "alan@example.com",
      }).returning({
        id: users.id,
        email: users.email,
      });

      if (rows.length !== 2 || rows[0]?.id !== 1) {
        throw new Error(
          "Drizzle fake proxy insert returning returned unexpected rows.",
        );
      }
      assertStats(proxy, { queries: 1 });
    },
  },
];

function assertStats(
  target: FakeDbProxy,
  expected: {
    readonly queries?: number;
    readonly executes?: number;
  },
): void {
  const stats = target.stats;

  if (
    (expected.queries !== undefined && stats.queries !== expected.queries) ||
    (expected.executes !== undefined && stats.executes !== expected.executes)
  ) {
    throw new Error(`Unexpected fake DB stats: ${JSON.stringify(stats)}`);
  }
}
