/**
 * Generated columns (v0.8 item 15) — the builder surface, the snapshot
 * shape, and the diff. Per-dialect DDL emission is pinned in each adapter's
 * `migrate/ddl_test.ts`.
 */
import { assertEquals, assertThrows } from "@std/assert";
import {
  columns,
  createSchemaSnapshot,
  defineTable,
  diffSchemaSnapshots,
  OrmError,
  sql,
} from "./mod.ts";

Deno.test("generatedAs: carried into the snapshot as portable text", () => {
  const docs = defineTable("docs", {
    id: columns.integer().primaryKey(),
    payload: columns.jsonb().notNull(),
    title: columns.text().generatedAs(sql`payload ->> 'title'`),
    upper: columns.text().generatedAs(sql`upper(title)`, { stored: false }),
  });
  const snapshot = createSchemaSnapshot({
    dialect: "postgres",
    tables: [docs],
  });
  const cols = snapshot.tables[0].columns;
  const title = cols.find((c) => c.name === "title");
  const upper = cols.find((c) => c.name === "upper");
  assertEquals(title?.generatedAs, {
    sql: "payload ->> 'title'",
    stored: true,
  });
  assertEquals(upper?.generatedAs, { sql: "upper(title)", stored: false });
});

Deno.test("generatedAs: a generated column is insert-optional", () => {
  const docs = defineTable("docs", {
    id: columns.integer().primaryKey(),
    payload: columns.jsonb().notNull(),
    title: columns.text().generatedAs(sql`payload ->> 'title'`),
  });
  // Type-level: the insert shape omits `title` (the database computes it), so
  // this satisfies InferInsert with only id + payload.
  const insert: import("./mod.ts").InferInsert<typeof docs> = {
    id: 1,
    payload: {},
  };
  assertEquals(insert.id, 1);
});

Deno.test("generatedAs: cannot combine with a default (either order)", () => {
  const base = columns.text();
  const genFirst = assertThrows(
    () => base.generatedAs(sql`1`).default("x"),
    OrmError,
    "generated column",
  );
  assertEquals((genFirst as OrmError).code, "ORM_INVALID_COLUMN");
  const defaultFirst = assertThrows(
    () => base.default("x").generatedAs(sql`1`),
    OrmError,
    "generated column",
  );
  assertEquals((defaultFirst as OrmError).code, "ORM_INVALID_COLUMN");
});

Deno.test("generatedAs: rejects a bound parameter and a non-sql expr", () => {
  const bad = defineTable("bad", {
    id: columns.integer().primaryKey(),
    x: columns.integer().generatedAs(sql`${5} + 1`),
  });
  const error = assertThrows(
    () => createSchemaSnapshot({ dialect: "postgres", tables: [bad] }),
    OrmError,
    "cannot bind parameters",
  );
  assertEquals((error as OrmError).code, "ORM_INVALID_COLUMN");
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => columns.text().generatedAs("not sql" as any),
    OrmError,
    "sql",
  );
});

Deno.test("generatedAs: a changed generation expression is a column change", () => {
  const before = createSchemaSnapshot({
    dialect: "postgres",
    tables: [defineTable("docs", {
      id: columns.integer().primaryKey(),
      title: columns.text().generatedAs(sql`payload ->> 'title'`),
    })],
  });
  const after = createSchemaSnapshot({
    dialect: "postgres",
    tables: [defineTable("docs", {
      id: columns.integer().primaryKey(),
      title: columns.text().generatedAs(sql`payload ->> 'name'`),
    })],
  });
  const diff = diffSchemaSnapshots(before, after);
  assertEquals(diff.changedTables.length, 1);
  assertEquals(diff.changedTables[0].columns.changed[0].name, "title");
});
