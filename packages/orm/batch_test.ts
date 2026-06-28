/**
 * Tests for the non-interactive batched transaction API (`db.batch`, roadmap
 * item 6): it renders each statement, prefers a driver's native `batch`, falls
 * back to an atomic `transaction`, surfaces unbound-placeholder errors before
 * touching the database, and accepts builders / `sql` fragments / rendered SQL.
 */
import { assertEquals, assertRejects } from "@std/assert";
import {
  columns,
  createDatabase,
  defineTable,
  eq,
  type OrmDriver,
  type OrmQueryResult,
  placeholder,
  sql,
  type SqlQuery,
} from "./mod.ts";

const posts = defineTable("posts", {
  id: columns.uuid().primaryKey(),
  score: columns.integer().notNull(),
});

// A driver that captures the batched queries and answers with one result each.
function batchDriver(): { driver: OrmDriver; calls: SqlQuery[][] } {
  const calls: SqlQuery[][] = [];
  return {
    calls,
    driver: {
      query: () => Promise.resolve({ rows: [], rowCount: 0 }),
      execute: () => Promise.resolve({ rows: [], rowCount: 0 }),
      batch(queries) {
        calls.push([...queries]);
        return Promise.resolve(
          queries.map(() => ({ rows: [], rowCount: 1 } as OrmQueryResult)),
        );
      },
    },
  };
}

// A driver with no native batch: db.batch must fall back to transaction().
function transactionDriver(): {
  driver: OrmDriver;
  order: string[];
  executed: SqlQuery[];
} {
  const order: string[] = [];
  const executed: SqlQuery[] = [];
  const record = (query: SqlQuery): Promise<OrmQueryResult> => {
    executed.push(query);
    if (query.text.includes("boom")) {
      return Promise.reject(new Error("boom"));
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  };
  return {
    order,
    executed,
    driver: {
      query: () => Promise.resolve({ rows: [], rowCount: 0 }),
      execute: record,
      async transaction(fn) {
        order.push("begin");
        try {
          const result = await fn({
            query: () => Promise.resolve({ rows: [], rowCount: 0 }),
            execute: record,
          });
          order.push("commit");
          return result;
        } catch (error) {
          order.push("rollback");
          throw error;
        }
      },
    },
  };
}

Deno.test("batch: uses a driver's native batch with rendered statements", async () => {
  const { driver, calls } = batchDriver();
  const db = createDatabase({ driver, dialect: "postgres" });

  const results = await db.batch([
    db.insert(posts).values({ id: "p1", score: 1 }),
    db.update(posts).set({ score: 2 }).where(eq(posts.columns.id, "p1")),
  ]);

  assertEquals(calls.length, 1); // a single batch call
  assertEquals(calls[0].map((q) => q.text), [
    'insert into "posts" ("id", "score") values ($1, $2)',
    'update "posts" set "score" = $1 where "posts"."id" = $2',
  ]);
  assertEquals(calls[0].map((q) => q.params), [["p1", 1], [2, "p1"]]);
  assertEquals(results.length, 2);
});

Deno.test("batch: accepts builders, sql fragments, and rendered SqlQuery", async () => {
  const { driver, calls } = batchDriver();
  const db = createDatabase({ driver, dialect: "postgres" });

  await db.batch([
    db.insert(posts).values({ id: "p1", score: 1 }),
    sql`update t set x = ${5}`,
    { text: "delete from t", params: [] },
  ]);

  assertEquals(calls[0].map((q) => q.text), [
    'insert into "posts" ("id", "score") values ($1, $2)',
    "update t set x = $1",
    "delete from t",
  ]);
  assertEquals(calls[0][1].params, [5]);
});

Deno.test("batch: falls back to an atomic transaction (begin/commit)", async () => {
  const { driver, order, executed } = transactionDriver();
  const db = createDatabase({ driver, dialect: "postgres" });

  const results = await db.batch([
    sql`update t set a = 1`,
    sql`update t set b = 2`,
  ]);

  assertEquals(order, ["begin", "commit"]);
  assertEquals(executed.map((q) => q.text), [
    "update t set a = 1",
    "update t set b = 2",
  ]);
  assertEquals(results.length, 2);
});

Deno.test("batch: a failing statement rolls the whole batch back", async () => {
  const { driver, order } = transactionDriver();
  const db = createDatabase({ driver, dialect: "postgres" });

  await assertRejects(() => db.batch([sql`update t set a = 1`, sql`boom`]));
  assertEquals(order, ["begin", "rollback"]);
});

Deno.test("batch: an unbound placeholder is rejected before any execution", async () => {
  const { driver, calls } = batchDriver();
  const db = createDatabase({ driver, dialect: "postgres" });

  await assertRejects(() =>
    db.batch([sql`update t set a = 1`, sql`select ${placeholder("x")}`])
  );
  // Rendering threw first, so the driver was never asked to run anything.
  assertEquals(calls.length, 0);
});

Deno.test("batch: an empty batch is a no-op", async () => {
  const { driver, calls } = batchDriver();
  const db = createDatabase({ driver, dialect: "postgres" });
  assertEquals(await db.batch([]), []);
  assertEquals(calls.length, 0);
});
