/**
 * JSON / array primitives (v0.8 item 14): array construction and scalar JSON
 * extraction compile to each engine's native function; `jsonTable` is the
 * set-returning source (PostgreSQL `jsonb_to_recordset`, MySQL `JSON_TABLE`,
 * SQLite `json_each` + per-field `json_extract`) usable through both the
 * fluent builder's raw `.from(...)` and `assembleSelect`.
 */
import { assert, assertEquals } from "@std/assert";
import {
  arrayExpr,
  assembleSelect,
  columns,
  createDatabase,
  defineTable,
  eq,
  identifier as sqlIdent,
  jsonExtract,
  jsonTable,
  renderSql,
  sql,
} from "./mod.ts";

const db = createDatabase({ dialect: "postgres" });
const docs = defineTable("docs", {
  id: columns.integer().primaryKey(),
  payload: columns.jsonb().notNull(),
});
const d = docs.columns;

Deno.test("arrayExpr: ARRAY[...] / json_array per dialect", () => {
  const q = arrayExpr<number>(1, 2, d.id);
  assertEquals(
    renderSql(q, { dialect: "postgres" }).text,
    'array[$1, $2, "docs"."id"]',
  );
  assertEquals(
    renderSql(q, { dialect: "mysql" }).text,
    "json_array(?, ?, `docs`.`id`)",
  );
  assertEquals(
    renderSql(q, { dialect: "sqlite" }).text,
    'json_array(?, ?, "docs"."id")',
  );
});

Deno.test("jsonExtract: scalar path extraction per dialect", () => {
  const q = jsonExtract(d.payload, "$.title");
  assertEquals(
    renderSql(q, { dialect: "postgres" }).text,
    `jsonb_extract_path_text("docs"."payload", 'title')`,
  );
  assertEquals(
    renderSql(q, { dialect: "mysql" }).text,
    "json_unquote(json_extract(`docs`.`payload`, '$.title'))",
  );
  assertEquals(
    renderSql(q, { dialect: "sqlite" }).text,
    `json_extract("docs"."payload", '$.title')`,
  );
});

Deno.test("jsonTable: set-returning FROM + typed refs, fluent builder", () => {
  const items = jsonTable(d.payload, {
    sku: { type: "text", path: "$.sku" },
    qty: { type: "integer", path: "$.qty" },
  }, { as: "item", path: "$.items" });

  // Postgres recordset with a typed column list.
  assertEquals(
    renderSql(
      db.select({ sku: items.columns.sku, qty: items.columns.qty })
        .from(items.from).toSql(),
      { dialect: "postgres" },
    ).text,
    'select "item"."sku" as "sku", "item"."qty" as "qty" from ' +
      `jsonb_to_recordset("docs"."payload" #> '{items}') ` +
      'as "item"("sku" text, "qty" integer)',
  );
  // MySQL JSON_TABLE COLUMNS.
  assertEquals(
    renderSql(
      db.select({ sku: items.columns.sku }).from(items.from).toSql(),
      { dialect: "mysql" },
    ).text,
    "select `item`.`sku` as `sku` from json_table(`docs`.`payload`, " +
      "'$.items[*]' columns (`sku` varchar(255) path '$.sku', " +
      "`qty` int path '$.qty')) as `item`",
  );
  // SQLite json_each + per-field json_extract in the projection.
  assertEquals(
    renderSql(
      db.select({ sku: items.columns.sku }).from(items.from).toSql(),
      { dialect: "sqlite" },
    ).text,
    `select json_extract("item"."value", '$.sku') as "sku" from ` +
      `json_each("docs"."payload", '$.items') as "item"`,
  );
});

Deno.test("jsonTable: composes with assembleSelect (core seam)", () => {
  const items = jsonTable(d.payload, {
    sku: { type: "text", path: "$.sku" },
  }, { as: "item", path: "$.items" });
  const stmt = assembleSelect({
    select: { sku: items.columns.sku },
    from: items.from,
  });
  assert(
    renderSql(stmt, { dialect: "postgres" }).text.includes(
      "jsonb_to_recordset",
    ),
  );
});

Deno.test("jsonTable: table-column source joins the base table (lateral)", () => {
  const items = jsonTable(d.payload, {
    sku: { type: "text", path: "$.sku" },
  }, { as: "item", path: "$.items" });
  // The source is a table column, so the base table joins the function.
  const q = db.select({ id: d.id, sku: items.columns.sku })
    .from(sql`${sqlIdent("docs")}, ${items.from}`)
    .where(eq(d.id, 1))
    .toSql();
  const text = renderSql(q, { dialect: "postgres" }).text;
  assert(text.includes('from "docs", jsonb_to_recordset'), text);
  assert(text.includes('"docs"."payload" #> '), text);
});
