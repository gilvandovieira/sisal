/**
 * Typed raw-query result mapping (v0.5.0 roadmap item 13). `db.query(sql).as(
 * table)` decodes raw driver rows against a `defineTable` model — physical→JS
 * column naming plus the same opt-in Temporal decoding the query builder
 * applies — yielding typed `InferSelect<table>` rows; `.as(map)` does the same
 * against a free-form `ColumnMap` for results that don't match one table. The
 * plain `await db.query(...)` result is unchanged.
 *
 * @module
 */
import { assertEquals, assertInstanceOf, assertThrows } from "@std/assert";
import {
  type ColumnMap,
  columns,
  createDatabase,
  defineTable,
  type OrmDriver,
  type OrmQueryResult,
  sql,
} from "./mod.ts";

// snake_case is the default naming strategy, so the physical columns are
// `bucket_start` / `activity_score` while the JS keys stay camelCase.
const buckets = defineTable("buckets", {
  bucketStart: columns.timestamp(),
  activityScore: columns.integer(),
  label: columns.text(),
});

function rowsDriver(rows: Record<string, unknown>[]): OrmDriver {
  return {
    query<T = unknown>() {
      return Promise.resolve({ rows: rows as T[], rowCount: rows.length });
    },
    execute() {
      return Promise.resolve({ rows: [], rowCount: 0 } as OrmQueryResult);
    },
  };
}

Deno.test("raw .as(table): renames physical columns to JS property keys", async () => {
  const db = createDatabase({
    driver: rowsDriver([
      { bucket_start: "2026-01-01 10:00:00", activity_score: 7, label: "x" },
    ]),
    dialect: "postgres",
  });

  const rows = await db.query(sql`select * from buckets`).as(buckets);

  assertEquals(rows.length, 1);
  assertEquals(rows[0].activityScore, 7);
  assertEquals(rows[0].label, "x");
  // No Temporal parsing on this db → the value passes through untouched. (The
  // inferred type stays optimistic — `Temporal.PlainDateTime` — exactly as the
  // builder's `InferSelect` does when parsing is off, so read it via the raw
  // shape here.)
  assertEquals(
    (rows[0] as Record<string, unknown>).bucketStart,
    "2026-01-01 10:00:00",
  );
});

Deno.test("raw .as(table): decodes Temporal columns when parsing is on", async () => {
  const db = createDatabase({
    driver: rowsDriver([
      { bucket_start: "2026-01-01 10:00:00", activity_score: 7, label: "x" },
    ]),
    dialect: "postgres",
    temporal: { parse: true },
  });

  const rows = await db.query(sql`select * from buckets`).as(buckets);

  const start = rows[0].bucketStart;
  assertInstanceOf(start, Temporal.PlainDateTime);
  assertEquals(start.toString(), "2026-01-01T10:00:00");
});

Deno.test("raw .as(table): unknown columns pass through untouched", async () => {
  const db = createDatabase({
    driver: rowsDriver([{ activity_score: 1, extra_total: 99 }]),
    dialect: "postgres",
  });

  const rows = await db.query(sql`select * from buckets`).as(buckets);

  assertEquals(rows[0].activityScore, 1);
  // A column the model does not know keeps its original key.
  assertEquals((rows[0] as Record<string, unknown>).extra_total, 99);
});

Deno.test("raw query result is still awaitable without .as()", async () => {
  const db = createDatabase({
    driver: rowsDriver([{ bucket_start: "raw", activity_score: 1 }]),
    dialect: "postgres",
  });

  const result = await db.query(sql`select * from buckets`);

  // The raw, driver-shaped row is returned unchanged (physical keys).
  assertEquals(result.rows[0], { bucket_start: "raw", activity_score: 1 });
});

Deno.test("raw .as(map): maps + decodes against a free-form column map", async () => {
  const db = createDatabase({
    driver: rowsDriver([{ bucket_start: "2026-01-01 10:00:00", n: 7 }]),
    dialect: "postgres",
    temporal: { parse: true },
  });

  // A join/aggregate shape that is not one defineTable: rename + decode per key.
  const shape: ColumnMap = {
    bucketStart: {
      name: "bucket_start",
      dataType: "timestamp",
      valueMode: "temporal",
    },
    count: { name: "n" },
  };
  const rows = await db.query(sql`select * from x`)
    .as<{ bucketStart: Temporal.PlainDateTime; count: number }>(shape);

  assertEquals(rows.length, 1);
  assertEquals(rows[0].count, 7); // renamed from `n`, no decode
  assertInstanceOf(rows[0].bucketStart, Temporal.PlainDateTime);
  assertEquals(rows[0].bucketStart.toString(), "2026-01-01T10:00:00");
});

Deno.test("raw .as(map): a bare descriptor keeps the key and value as-is", async () => {
  const db = createDatabase({
    driver: rowsDriver([{ at: "2026-01-01 10:00:00" }]),
    dialect: "postgres",
    temporal: { parse: true },
  });

  // No name (key === physical) and no dataType ⇒ no rename, no decode.
  const rows = await db.query(sql`select * from x`).as({ at: {} });
  assertEquals(rows[0], { at: "2026-01-01 10:00:00" });
});

Deno.test("raw .as(...): rejects a non-table, non-object argument", () => {
  const db = createDatabase({
    driver: rowsDriver([{ n: 1 }]),
    dialect: "postgres",
  });

  // deno-lint-ignore no-explicit-any
  assertThrows(() => db.query(sql`select 1`).as(42 as any));
});
