/**
 * Column-naming strategy tests for `@sisal/orm`: the snake_case default, the
 * per-table `naming` override, the global default getter/setter, explicit
 * `.named(...)` precedence, and the write/read SQL each produces.
 */
import { assertEquals, assertThrows } from "@std/assert";
import {
  columns,
  createDatabase,
  createSchemaSnapshot,
  defineTable,
  eq,
  getDefaultColumnNaming,
  type InferSelect,
  renderSql,
  setDefaultColumnNaming,
  type Sql,
} from "./mod.ts";

const db = createDatabase({ dialect: "postgres" });

function text(query: { toSql(): Sql }): string {
  return renderSql(query.toSql(), { dialect: "postgres" }).text;
}

Deno.test("naming: snake_case is the default for camelCase keys", () => {
  const posts = defineTable("posts", {
    id: columns.uuid().primaryKey(),
    hotScore: columns.doublePrecision().notNull(),
    createdAt: columns.timestamp({ withTimezone: true, mode: "date" })
      .notNull(),
  });

  // Property keys stay camelCase; physical column names become snake_case.
  assertEquals(posts.columns.hotScore.name, "hot_score");
  assertEquals(posts.columns.createdAt.name, "created_at");
  assertEquals(posts.columns.id.name, "id"); // single words unchanged
  assertEquals(posts.columns.hotScore.propertyName, "hotScore");

  // Inference still uses the JS-side key names.
  const row: InferSelect<typeof posts> = {
    id: "p1",
    hotScore: 1.5,
    createdAt: new Date(0),
  };
  assertEquals(row.hotScore, 1.5);
});

Deno.test("naming: select expands to aliased projection (read maps to keys)", () => {
  const posts = defineTable("posts", {
    id: columns.uuid().primaryKey(),
    hotScore: columns.doublePrecision().notNull(),
  });

  assertEquals(
    text(db.select().from(posts)),
    'select "posts"."id" as "id", "posts"."hot_score" as "hotScore" from "posts"',
  );
});

Deno.test("naming: an all-identity table still renders SELECT *", () => {
  const tags = defineTable("tags", {
    id: columns.uuid().primaryKey(),
    label: columns.text().notNull(),
  });
  assertEquals(text(db.select().from(tags)), 'select * from "tags"');
});

Deno.test("naming: insert/update/returning emit physical names", () => {
  const posts = defineTable("posts", {
    id: columns.uuid().primaryKey(),
    hotScore: columns.doublePrecision().notNull(),
  });

  assertEquals(
    text(db.insert(posts).values({ id: "p1", hotScore: 1 })),
    'insert into "posts" ("id", "hot_score") values ($1, $2)',
  );

  assertEquals(
    text(
      db.update(posts).set({ hotScore: 2 }).where(eq(posts.columns.id, "p1"))
        .returning(),
    ),
    'update "posts" set "hot_score" = $1 where "posts"."id" = $2 ' +
      'returning "posts"."id" as "id", "posts"."hot_score" as "hotScore"',
  );
});

Deno.test("naming: onConflict target + set map property keys to physical", () => {
  const posts = defineTable("posts", {
    id: columns.uuid().primaryKey(),
    hotScore: columns.doublePrecision().notNull(),
  });

  assertEquals(
    text(
      db.insert(posts).values({ id: "p1", hotScore: 1 }).onConflictDoUpdate({
        target: "hotScore",
        set: { hotScore: 9 },
      }),
    ),
    'insert into "posts" ("id", "hot_score") values ($1, $2) ' +
      'on conflict ("hot_score") do update set "hot_score" = $3',
  );
});

Deno.test("naming: per-table override (preserve / camelCase / custom fn)", () => {
  const verbatim = defineTable("verbatim", {
    hotScore: columns.doublePrecision(),
  }, { naming: "preserve" });
  assertEquals(verbatim.columns.hotScore.name, "hotScore");

  const camel = defineTable("camel", {
    hot_score: columns.doublePrecision(),
  }, { naming: "camelCase" });
  assertEquals(camel.columns.hot_score.name, "hotScore");

  const prefixed = defineTable("prefixed", {
    score: columns.integer(),
  }, { naming: (key) => `col_${key}` });
  assertEquals(prefixed.columns.score.name, "col_score");
});

Deno.test("naming: explicit .named(...) wins over any strategy", () => {
  const posts = defineTable("posts", {
    hotScore: columns.doublePrecision().named("hotness"),
  }, { naming: "snake_case" });
  assertEquals(posts.columns.hotScore.name, "hotness");
});

Deno.test("naming: snapshot uses physical names + carries propertyName", () => {
  const posts = defineTable("posts", {
    hotScore: columns.doublePrecision().notNull(),
  });
  const snapshot = createSchemaSnapshot({
    dialect: "postgres",
    tables: [posts],
  });
  const column = snapshot.tables[0].columns[0];
  assertEquals(column.name, "hot_score");
  assertEquals(column.metadata?.propertyName, "hotScore");
});

Deno.test("naming: global default getter/setter (restored after)", () => {
  assertEquals(getDefaultColumnNaming(), "snake_case");
  try {
    setDefaultColumnNaming("preserve");
    const t = defineTable("t", { hotScore: columns.integer() });
    assertEquals(t.columns.hotScore.name, "hotScore");
    assertEquals(getDefaultColumnNaming(), "preserve");
  } finally {
    setDefaultColumnNaming("snake_case");
  }
});

Deno.test("naming: invalid strategy is rejected", () => {
  assertThrows(() =>
    defineTable("t", { a: columns.text() }, {
      naming: "kebab-case" as unknown as "snake_case",
    })
  );
  assertThrows(() => setDefaultColumnNaming("nope" as unknown as "snake_case"));
});
