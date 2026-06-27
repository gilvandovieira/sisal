/**
 * Head-to-head execution + result-mapping benchmarks: Sisal vs Drizzle 0.45.2.
 *
 * Generation ({@link ./vs_drizzle.ts}) is only half of a query's cost. The other
 * half is the *read path*: dispatching the statement and turning the driver's
 * raw rows into typed result objects. This file measures exactly that, with the
 * database replaced by a zero-latency fake that returns identical canned rows —
 * so no TCP, no engine, just each ORM's own dispatch + row-mapping work.
 *
 * Row count is the stressor (mapping cost scales with rows), so every operation
 * is swept across 1 / 100 / 1000 rows, with Sisal as the baseline in each group.
 *
 * Fairness note — the two ORMs are measured from their *own* driver boundaries,
 * which differ by design: Sisal's `OrmDriver` hands back name-keyed row objects
 * (a real adapter builds those in native code), while Drizzle's proxy hands back
 * positional arrays that Drizzle maps to fields and coerces per column. Part of
 * the gap is therefore *where* column-naming happens, not pure overhead. These
 * numbers are the realistic per-query read cost of each library, not an isolated
 * "mapping only" microbenchmark.
 *
 * @module
 */

import { columns, createDatabase, defineTable, eq } from "@sisal/orm";

import { eq as dEq } from "drizzle-orm";
import {
  boolean as pgBoolean,
  integer as pgInteger,
  pgTable,
  text as pgText,
} from "drizzle-orm/pg-core";
import { drizzle as drizzlePgProxy } from "drizzle-orm/pg-proxy";
import {
  integer as sqliteInteger,
  sqliteTable,
  text as sqliteText,
} from "drizzle-orm/sqlite-core";
import { drizzle as drizzleSqliteProxy } from "drizzle-orm/sqlite-proxy";

import { createFakeDbProxy, type FakeDbRow } from "../fakedbproxy.ts";
import type { BenchmarkScenario } from "../harness.ts";

const ROW_COUNTS = [1, 100, 1000] as const;
const COLUMN_ORDER = ["id", "email", "name", "age", "active"] as const;

function makeRows(count: number): FakeDbRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    email: `user${index + 1}@example.com`,
    name: `User ${index + 1}`,
    age: 20 + (index % 40),
    active: index % 2 === 0,
  }));
}

// ---------------------------------------------------------------------------
// Sisal — reads through its OrmDriver boundary (name-keyed rows).
// ---------------------------------------------------------------------------
const sUsers = defineTable("users", {
  id: columns.integer().primaryKey(),
  email: columns.text().notNull(),
  name: columns.text(),
  age: columns.integer(),
  active: columns.boolean(),
});
const sProjection = {
  id: sUsers.columns.id,
  email: sUsers.columns.email,
  name: sUsers.columns.name,
  age: sUsers.columns.age,
  active: sUsers.columns.active,
};

interface Reader {
  readonly reset: () => void;
  readonly run: () => Promise<unknown>;
}

function sisalReader(count: number, dialect: "postgres" | "sqlite"): Reader {
  // cloneRows: a real driver allocates fresh row objects per query, so the fake
  // does too — otherwise Sisal's read path would skip allocation the others pay.
  const proxy = createFakeDbProxy({ rows: makeRows(count), cloneRows: true });
  const db = createDatabase({ driver: proxy.asOrmDriver(), dialect });
  return {
    reset: () => proxy.reset(),
    run: () =>
      db.select(sProjection).from(sUsers).where(eq(sUsers.columns.id, 1))
        .execute(),
  };
}

// ---------------------------------------------------------------------------
// Drizzle — reads through its proxy boundary (positional rows it maps to fields).
// ---------------------------------------------------------------------------
const pgUsers = pgTable("users", {
  id: pgInteger("id").primaryKey(),
  email: pgText("email").notNull(),
  name: pgText("name"),
  age: pgInteger("age"),
  active: pgBoolean("active"),
});
const sqUsers = sqliteTable("users", {
  id: sqliteInteger("id").primaryKey(),
  email: sqliteText("email").notNull(),
  name: sqliteText("name"),
  age: sqliteInteger("age"),
  active: sqliteInteger("active", { mode: "boolean" }),
});

function drizzlePgReader(count: number): Reader {
  const proxy = createFakeDbProxy({ rows: makeRows(count) });
  const db = drizzlePgProxy(
    proxy.asDrizzlePgProxy({ columns: [...COLUMN_ORDER] }),
  );
  return {
    reset: () => proxy.reset(),
    run: () =>
      db.select({
        id: pgUsers.id,
        email: pgUsers.email,
        name: pgUsers.name,
        age: pgUsers.age,
        active: pgUsers.active,
      }).from(pgUsers).where(dEq(pgUsers.id, 1)),
  };
}

function drizzleSqliteReader(count: number): Reader {
  const proxy = createFakeDbProxy({ rows: makeRows(count) });
  const executor = proxy.asSqlExecutor();
  // sqlite-proxy hands Drizzle positional rows, same shape as pg-proxy; we build
  // the client locally from the public executor so the fake proxy is untouched.
  const client = async (
    sql: string,
    params: readonly unknown[],
    method: "run" | "all" | "values" | "get",
  ): Promise<{ rows: unknown[] }> => {
    const { rows } = await executor.execute(sql, params);
    if (method === "run") {
      return { rows: [] };
    }
    const positional = rows.map((row) => COLUMN_ORDER.map((col) => row[col]));
    return { rows: method === "get" ? positional[0] ?? [] : positional };
  };
  const db = drizzleSqliteProxy(client);
  return {
    reset: () => proxy.reset(),
    run: () =>
      db.select({
        id: sqUsers.id,
        email: sqUsers.email,
        name: sqUsers.name,
        age: sqUsers.age,
        active: sqUsers.active,
      }).from(sqUsers).where(dEq(sqUsers.id, 1)),
  };
}

interface Pairing {
  readonly dialect: string;
  readonly count: number;
  readonly sisal: Reader;
  readonly drizzle: Reader;
}

const pairings: readonly Pairing[] = ROW_COUNTS.flatMap((count) => [
  {
    dialect: "pg",
    count,
    sisal: sisalReader(count, "postgres"),
    drizzle: drizzlePgReader(count),
  },
  {
    dialect: "sqlite",
    count,
    sisal: sisalReader(count, "sqlite"),
    drizzle: drizzleSqliteReader(count),
  },
]);

// Fail fast if a read path stops returning the expected row count.
await assertReads();

export const vsDrizzleExecuteScenarios: readonly BenchmarkScenario[] = pairings
  .flatMap((pairing) => {
    const group = `${pairing.dialect} read · ${pairing.count} ${
      pairing.count === 1 ? "row" : "rows"
    }`;
    return [
      {
        group,
        name: "sisal",
        baseline: true,
        async fn() {
          pairing.sisal.reset();
          await pairing.sisal.run();
        },
      },
      {
        group,
        name: "drizzle",
        async fn() {
          pairing.drizzle.reset();
          await pairing.drizzle.run();
        },
      },
    ];
  });

async function assertReads(): Promise<void> {
  for (const pairing of pairings) {
    for (const reader of [pairing.sisal, pairing.drizzle]) {
      reader.reset();
      const rows = await reader.run();
      const length = Array.isArray(rows) ? rows.length : -1;
      if (length !== pairing.count) {
        throw new Error(
          `Read benchmark setup returned ${length} rows, expected ${pairing.count}.`,
        );
      }
    }
  }
}
