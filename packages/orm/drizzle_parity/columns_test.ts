import { assertEquals, assertThrows } from "@std/assert";
import {
  columns,
  createSchemaSnapshot,
  defineTable,
  eq,
  type InferInsert,
  type InferSelect,
  renderSql,
} from "../mod.ts";
import { db } from "./_fixtures.ts";

Deno.test("parity: column type factories exist", () => {
  const factory = columns as unknown as Record<string, unknown>;
  // Shared with Drizzle
  for (
    const name of [
      "text",
      "varchar",
      "char",
      "integer",
      "smallint",
      "bigint",
      "serial",
      "bigserial",
      "numeric",
      "decimal",
      "real",
      "doublePrecision",
      "boolean",
      "timestamp",
      "uuid",
      "bytea",
      "json",
      "jsonb",
      "date",
      "customType",
    ]
  ) {
    assertEquals(typeof factory[name], "function", `columns.${name}`);
  }
});

Deno.test("parity: column modifiers (shared, extra, and gaps)", () => {
  const builder = columns.text() as unknown as Record<string, unknown>;
  for (
    const name of [
      "notNull",
      "default",
      "primaryKey",
      "unique",
      "references",
      "array",
      "$onUpdate",
    ]
  ) {
    assertEquals(typeof builder[name], "function", `.${name}()`);
  }
  // Sisal-specific modifiers Drizzle lacks
  for (const name of ["nullable", "optional", "named"]) {
    assertEquals(typeof builder[name], "function", `.${name}()`);
  }
  // Drizzle modifiers Sisal has not implemented (different mechanism or gap)
  for (const name of ["$type", "$default", "$defaultFn", "generatedAlwaysAs"]) {
    assertEquals(builder[name], undefined, `.${name}() unexpectedly present`);
  }
});

Deno.test("parity: column casing (naming strategy ~ Drizzle `casing`)", () => {
  // Divergence: Sisal applies `snake_case` by default; Drizzle applies no
  // casing unless `casing: "snake_case"` is set. `naming: "snake_case"` matches
  // Drizzle's `casing: "snake_case"` — the JS key stays camelCase, the physical
  // column is snake_case, and a star select aliases back to the key on read.
  const widgets = defineTable("widgets", {
    hotScore: columns.doublePrecision().notNull(),
  });
  assertEquals(widgets.columns.hotScore.name, "hot_score");
  assertEquals(widgets.columns.hotScore.propertyName, "hotScore");
  assertEquals(
    renderSql(db.select().from(widgets).toSql(), { dialect: "postgres" }).text,
    'select "widgets"."hot_score" as "hotScore" from "widgets"',
  );

  // `naming: "preserve"` matches Drizzle's default (no casing).
  const verbatim = defineTable("verbatim", {
    hotScore: columns.doublePrecision(),
  }, { naming: "preserve" });
  assertEquals(verbatim.columns.hotScore.name, "hotScore");

  // `.named(x)` is Sisal's explicit-name path (~ Drizzle `doublePrecision("x")`)
  // and always wins over the strategy.
  const explicit = defineTable("explicit", {
    hotScore: columns.doublePrecision().named("hotness"),
  });
  assertEquals(explicit.columns.hotScore.name, "hotness");
});

Deno.test("parity: new column types render in DDL via snapshot", () => {
  const t = defineTable("widgets", {
    id: columns.serial().primaryKey(),
    code: columns.char(4).notNull(),
    price: columns.numeric(10, 2).notNull(),
    weight: columns.doublePrecision(),
    size: columns.smallint(),
    tags: columns.text().array(),
  });
  const snapshot = createSchemaSnapshot({ dialect: "postgres", tables: [t] });
  const widgets = snapshot.tables[0];
  const typeOf = (name: string) =>
    widgets.columns.find((c) => c.name === name)!.type;

  assertEquals(typeOf("id").kind, "serial");
  assertEquals(typeOf("code"), { kind: "char", length: 4 });
  assertEquals(typeOf("price"), { kind: "numeric", precision: 10, scale: 2 });
  assertEquals(typeOf("weight").kind, "double");
  assertEquals(typeOf("size").kind, "smallint");
  assertEquals(typeOf("tags"), { kind: "text", array: true });

  // serial is optional on insert (DB-generated, omit `id`); nullable columns
  // remain required unless `.optional()`, so pass them explicitly as null.
  const _insert: InferInsert<typeof t> = {
    code: "ABCD",
    price: "9.99",
    weight: null,
    size: null,
    tags: null,
  };
  assertEquals(_insert.code, "ABCD");
});

Deno.test("parity: customType exposes dialectType escape hatch", () => {
  const extensions = defineTable(
    "extensions",
    {
      status: columns.customType<"draft" | "published">({
        kind: "enum",
        dialectType: "post_status",
      }),
      embedding: columns.customType<number[]>({
        kind: "vector",
        dialectType: "vector(3)",
      }).notNull(),
      activeAt: columns.customType<Date>({
        kind: "time",
        dialectType: "time",
      }),
      retention: columns.customType<string>({
        kind: "interval",
        dialectType: "interval",
      }),
      address: columns.customType<string>({
        kind: "inet",
        dialectType: "inet",
      }),
      identity: columns.customType<number>({
        kind: "integer",
        dialectType: "integer generated always as identity",
      }).optional(),
    },
    { naming: "preserve" },
  );
  const snapshot = createSchemaSnapshot({
    dialect: "postgres",
    tables: [extensions],
  });
  const typeOf = (name: string) =>
    snapshot.tables[0].columns.find((c) => c.name === name)!.type;

  assertEquals(typeOf("status"), {
    kind: "enum",
    dialectType: "post_status",
  });
  assertEquals(typeOf("embedding"), {
    kind: "vector",
    dialectType: "vector(3)",
  });
  assertEquals(typeOf("activeAt"), { kind: "time", dialectType: "time" });
  assertEquals(typeOf("retention"), {
    kind: "interval",
    dialectType: "interval",
  });
  assertEquals(typeOf("address"), { kind: "inet", dialectType: "inet" });
  assertEquals(typeOf("identity"), {
    kind: "integer",
    dialectType: "integer generated always as identity",
  });

  const row: InferSelect<typeof extensions> = {
    status: "draft",
    embedding: [1, 2, 3],
    activeAt: null,
    retention: null,
    address: null,
    identity: null,
  };
  const insert: InferInsert<typeof extensions> = {
    status: null,
    embedding: [1, 2, 3],
    activeAt: null,
    retention: null,
    address: null,
  };
  assertEquals(row.status, "draft");
  assertEquals(row.embedding, [1, 2, 3]);
  assertEquals(insert.embedding, [1, 2, 3]);
  assertThrows(() => columns.customType({ kind: "" }));
  assertThrows(() => columns.customType({ kind: "vector", dialectType: "" }));
});

Deno.test("parity: .$onUpdate() injects a value on UPDATE", () => {
  const fixed = new Date(0);
  const posts = defineTable(
    "posts",
    {
      id: columns.integer().primaryKey(),
      title: columns.text().notNull(),
      updatedAt: columns.timestamp().$onUpdate(() => fixed),
    },
    { naming: "preserve" },
  );
  const query = db.update(posts).set({ title: "x" })
    .where(eq(posts.columns.id, 1)).toSql();
  const rendered = renderSql(query, { dialect: "postgres" });
  assertEquals(
    rendered.text,
    'update "posts" set "title" = $1, "updatedAt" = $2 where "posts"."id" = $3',
  );
  assertEquals(rendered.params, ["x", fixed, 1]);
});

Deno.test("parity: columns are nullable by default; .notNull() / .primaryKey() opt out", () => {
  const t = defineTable("t", {
    a: columns.text(), // nullable by default, like Drizzle/SQL
    b: columns.text().notNull(), // opt into NOT NULL
    id: columns.uuid().primaryKey(), // primary key implies NOT NULL
  });
  assertEquals(t.columns.a.nullable, true);
  assertEquals(t.columns.b.nullable, false);
  assertEquals(t.columns.id.nullable, false);
  // .optional() is an insert-only axis and does not change nullability.
  assertEquals(
    defineTable("t2", { a: columns.text().optional() }).columns.a.nullable,
    true,
  );
});
