/**
 * Drizzle ORM 0.45.2 parity tests for `@sisal/orm`.
 *
 * These pin Sisal's public surface against the equivalent Drizzle 0.45.2
 * surface. They do two jobs:
 *
 *  1. Parity guardrail — the operators, column factories, builder methods, and
 *     SQL helpers we claim to match Drizzle on must keep existing and behaving.
 *  2. Roadmap ledger — Drizzle features we have NOT built yet are asserted to be
 *     absent, so adding one fails a test that points at docs/drizzle-parity.md.
 *
 * See ../../docs/drizzle-parity.md for the human-readable matrix and roadmap.
 */
import { assertEquals, assertThrows } from "@std/assert";
import * as orm from "./mod.ts";
import {
  and,
  asc,
  avg,
  between,
  columns,
  type Condition,
  count,
  createDatabase,
  createSchemaSnapshot,
  defineTable,
  desc,
  emptySql,
  eq,
  gt,
  gte,
  identifier,
  ilike,
  inArray,
  type InferInsert,
  type InferSelect,
  isNotNull,
  isNull,
  joinSql,
  like,
  lt,
  lte,
  max,
  min,
  ne,
  not,
  notBetween,
  notIlike,
  notInArray,
  notLike,
  or,
  type OrmDriver,
  type OrmQueryResult,
  raw,
  relations,
  renderSql,
  sql,
  type SqlDialect,
  type SqlQuery,
  sum,
  toSql,
} from "./mod.ts";

// Cast for "is this Drizzle name absent?" checks without compile errors.
const api = orm as unknown as Record<string, unknown>;

const users = defineTable("users", {
  id: columns.integer().primaryKey(),
  name: columns.text().notNull(),
  age: columns.integer().optional(),
});

const db = createDatabase({ dialect: "postgres" });

function render(condition: Condition, dialect: SqlDialect = "postgres") {
  return renderSql(toSql(condition), { dialect });
}

// ---------------------------------------------------------------------------
// 1. Filter operators
// ---------------------------------------------------------------------------

Deno.test("parity: comparison operators render Drizzle-equivalent SQL", () => {
  assertEquals(render(eq(users.columns.id, 42)).text, '"users"."id" = $1');
  assertEquals(render(eq(users.columns.id, 42)).params, [42]);
  assertEquals(render(ne(users.columns.id, 42)).text, '"users"."id" <> $1');
  assertEquals(render(gt(users.columns.id, 42)).text, '"users"."id" > $1');
  assertEquals(render(gte(users.columns.id, 42)).text, '"users"."id" >= $1');
  assertEquals(render(lt(users.columns.id, 42)).text, '"users"."id" < $1');
  assertEquals(render(lte(users.columns.id, 42)).text, '"users"."id" <= $1');
});

Deno.test("parity: like / ilike", () => {
  assertEquals(
    render(like(users.columns.name, "a%")).text,
    '"users"."name" like $1',
  );
  assertEquals(
    render(ilike(users.columns.name, "a%")).text,
    '"users"."name" ilike $1',
  );
});

Deno.test("parity: ilike degrades to like off Postgres (no ILIKE keyword)", () => {
  // SQLite/libSQL/MySQL have no ILIKE; their LIKE is case-insensitive (ASCII).
  assertEquals(
    render(ilike(users.columns.name, "a%"), "sqlite").text,
    '"users"."name" like ?',
  );
  assertEquals(
    render(notIlike(users.columns.name, "a%"), "sqlite").text,
    '"users"."name" not like ?',
  );
});

Deno.test("parity: notLike / notIlike", () => {
  assertEquals(
    render(notLike(users.columns.name, "a%")).text,
    '"users"."name" not like $1',
  );
  assertEquals(
    render(notIlike(users.columns.name, "a%")).text,
    '"users"."name" not ilike $1',
  );
});

Deno.test("parity: between / notBetween", () => {
  assertEquals(
    render(between(users.columns.age, 18, 35)),
    { text: '"users"."age" between $1 and $2', params: [18, 35] },
  );
  assertEquals(
    render(notBetween(users.columns.age, 18, 35)).text,
    '"users"."age" not between $1 and $2',
  );
});

Deno.test("parity: inArray / notInArray (with safe empty divergence)", () => {
  assertEquals(
    render(inArray(users.columns.id, [1, 2, 3])).text,
    '"users"."id" in ($1, $2, $3)',
  );
  assertEquals(render(inArray(users.columns.id, [1, 2, 3])).params, [1, 2, 3]);
  assertEquals(
    render(notInArray(users.columns.id, [1])).text,
    '"users"."id" not in ($1)',
  );
  // Divergence: Drizzle throws on empty inArray; Sisal yields a constant.
  assertEquals(render(inArray(users.columns.id, [])).text, "1 = 0");
  assertEquals(render(notInArray(users.columns.id, [])).text, "1 = 1");
});

Deno.test("parity: isNull / isNotNull", () => {
  assertEquals(render(isNull(users.columns.age)).text, '"users"."age" is null');
  assertEquals(
    render(isNotNull(users.columns.age)).text,
    '"users"."age" is not null',
  );
});

Deno.test("parity: and / or / not (nullish args ignored)", () => {
  assertEquals(
    render(and(eq(users.columns.id, 1), gt(users.columns.age, 18))).text,
    '("users"."id" = $1) and ("users"."age" > $2)',
  );
  assertEquals(
    render(or(eq(users.columns.id, 1), eq(users.columns.id, 2))).text,
    '("users"."id" = $1) or ("users"."id" = $2)',
  );
  assertEquals(
    render(not(eq(users.columns.id, 1))).text,
    'not ("users"."id" = $1)',
  );
  // Divergence: nullish conditions are dropped, so a lone real condition stands.
  assertEquals(
    render(and(eq(users.columns.id, 1), undefined, null)).text,
    '"users"."id" = $1',
  );
});

Deno.test("roadmap: Drizzle operators not yet implemented are absent", () => {
  for (
    const name of [
      "exists",
      "notExists",
      "arrayContains",
      "arrayContained",
      "arrayOverlaps",
    ]
  ) {
    assertEquals(
      api[name],
      undefined,
      `${name} is now exported — move it to ✅ in docs/drizzle-parity.md`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. Columns
// ---------------------------------------------------------------------------

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

Deno.test("parity: .$onUpdate() injects a value on UPDATE", () => {
  const fixed = new Date(0);
  const posts = defineTable("posts", {
    id: columns.integer().primaryKey(),
    title: columns.text().notNull(),
    updatedAt: columns.timestamp().$onUpdate(() => fixed),
  });
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

// ---------------------------------------------------------------------------
// 3. Query builder
// ---------------------------------------------------------------------------

Deno.test("parity: select ... where ... orderBy ... limit ... offset", () => {
  const query = db.select().from(users)
    .where(eq(users.columns.id, 1))
    .orderBy(users.columns.id, "desc")
    .limit(10)
    .offset(5)
    .toSql();
  assertEquals(renderSql(query, { dialect: "postgres" }), {
    text:
      'select * from "users" where "users"."id" = $1 order by "users"."id" desc limit $2 offset $3',
    params: [1, 10, 5],
  });
});

Deno.test("parity: select projection (aliased columns)", () => {
  const query = db
    .select({ userId: users.columns.id, label: users.columns.name })
    .from(users)
    .toSql();
  assertEquals(
    renderSql(query, { dialect: "postgres" }).text,
    'select "users"."id" as "userId", "users"."name" as "label" from "users"',
  );
});

Deno.test("parity: asc() / desc() ordering helpers + multi-column orderBy", () => {
  const query = db.select().from(users)
    .orderBy(desc(users.columns.age), asc(users.columns.name))
    .toSql();
  assertEquals(
    renderSql(query, { dialect: "postgres" }).text,
    'select * from "users" order by "users"."age" desc, "users"."name" asc',
  );
});

Deno.test("parity: aggregate helpers (count/sum/avg/min/max)", () => {
  const query = db.select({
    total: count(),
    ids: count(users.columns.id),
    sumAge: sum(users.columns.age),
    avgAge: avg(users.columns.age),
    minAge: min(users.columns.age),
    maxAge: max(users.columns.age),
  }).from(users).toSql();
  assertEquals(
    renderSql(query, { dialect: "postgres" }).text,
    'select count(*) as "total", count("users"."id") as "ids", ' +
      'sum("users"."age") as "sumAge", avg("users"."age") as "avgAge", ' +
      'min("users"."age") as "minAge", max("users"."age") as "maxAge" ' +
      'from "users"',
  );
  // count() infers as number at the type level (compile-time parity check).
  const _typed: number = count().__exprType ?? 0;
  assertEquals(typeof _typed, "number");
});

Deno.test("parity: insert ... values ... returning", () => {
  const query = db.insert(users).values({ id: 1, name: "a" }).returning()
    .toSql();
  assertEquals(renderSql(query, { dialect: "postgres" }), {
    text: 'insert into "users" ("id", "name") values ($1, $2) returning *',
    params: [1, "a"],
  });
});

Deno.test("parity: update ... set ... where", () => {
  const query = db.update(users).set({ name: "b" })
    .where(eq(users.columns.id, 1)).toSql();
  assertEquals(renderSql(query, { dialect: "postgres" }), {
    text: 'update "users" set "name" = $1 where "users"."id" = $2',
    params: ["b", 1],
  });
});

Deno.test("parity: delete ... where", () => {
  const query = db.delete(users).where(eq(users.columns.id, 1)).toSql();
  assertEquals(renderSql(query, { dialect: "postgres" }), {
    text: 'delete from "users" where "users"."id" = $1',
    params: [1],
  });
});

Deno.test("divergence: where-less update/delete is refused unless opted in", () => {
  assertThrows(() => db.update(users).set({ name: "x" }).toSql());
  assertThrows(() => db.delete(users).toSql());
  assertEquals(
    renderSql(db.delete(users).unsafeAllowAllRows().toSql(), {
      dialect: "postgres",
    }).text,
    'delete from "users"',
  );
});

Deno.test("parity: builder methods present (joins, distinct, groupBy/having, upsert)", () => {
  const select = db.select().from(users) as unknown as Record<string, unknown>;
  for (
    const name of [
      "innerJoin",
      "leftJoin",
      "rightJoin",
      "fullJoin",
      "distinct",
      "groupBy",
      "having",
    ]
  ) {
    assertEquals(typeof select[name], "function", `select.${name}`);
  }
  const insert = db.insert(users) as unknown as Record<string, unknown>;
  for (const name of ["onConflictDoNothing", "onConflictDoUpdate"]) {
    assertEquals(typeof insert[name], "function", `insert.${name}`);
  }
  // Still a gap: the dynamic-query escape hatch.
  assertEquals(select.$dynamic, undefined);
});

Deno.test("parity: distinct + right/full joins render", () => {
  const posts = defineTable("posts", {
    id: columns.integer().primaryKey(),
    userId: columns.integer().notNull(),
  });
  const query = db.select().from(users).distinct()
    .rightJoin(posts, eq(posts.columns.userId, users.columns.id))
    .fullJoin(posts, eq(posts.columns.userId, users.columns.id))
    .toSql();
  assertEquals(
    renderSql(query, { dialect: "postgres" }).text,
    'select distinct * from "users" ' +
      'right join "posts" on "posts"."userId" = "users"."id" ' +
      'full join "posts" on "posts"."userId" = "users"."id"',
  );
});

Deno.test("parity: groupBy + having", () => {
  const query = db
    .select({ name: users.columns.name, total: count() })
    .from(users)
    .groupBy(users.columns.name)
    .having(gt(count(), 1))
    .toSql();
  assertEquals(
    renderSql(query, { dialect: "postgres" }).text,
    'select "users"."name" as "name", count(*) as "total" from "users" ' +
      'group by "users"."name" having count(*) > $1',
  );
});

Deno.test("parity: onConflictDoNothing / onConflictDoUpdate (upsert)", () => {
  const doNothing = db.insert(users).values({ id: 1, name: "a" })
    .onConflictDoNothing({ target: users.columns.id }).toSql();
  assertEquals(
    renderSql(doNothing, { dialect: "postgres" }).text,
    'insert into "users" ("id", "name") values ($1, $2) ' +
      'on conflict ("id") do nothing',
  );

  const doUpdate = db.insert(users).values({ id: 1, name: "a" })
    .onConflictDoUpdate({
      target: users.columns.id,
      set: { name: "b" },
      where: eq(users.columns.id, 1),
    })
    .returning()
    .toSql();
  assertEquals(renderSql(doUpdate, { dialect: "postgres" }), {
    text: 'insert into "users" ("id", "name") values ($1, $2) ' +
      'on conflict ("id") do update set "name" = $3 where "users"."id" = $4 ' +
      "returning *",
    params: [1, "a", "b", 1],
  });
});

Deno.test("parity: relations() + db.query.table.findMany/findFirst with with/columns", async () => {
  const posts = defineTable("posts", {
    id: columns.integer().primaryKey(),
    userId: columns.integer().notNull().references("users", "id"),
    title: columns.text().notNull(),
  });
  const usersRelations = relations(users, ({ many }) => ({
    posts: many(posts),
  }));
  const postsRelations = relations(posts, ({ one }) => ({
    author: one(users, {
      fields: [posts.columns.userId],
      references: [users.columns.id],
    }),
  }));
  const queries: SqlQuery[] = [];
  const driver: OrmDriver = {
    query<T = unknown>(query: SqlQuery): Promise<OrmQueryResult<T>> {
      queries.push(query);

      if (
        query.text.includes('from "users"') &&
        query.text.includes('where "users"."id" in')
      ) {
        return Promise.resolve({
          rows: [{ id: 1, name: "Ana" }] as T[],
          rowCount: 1,
        });
      }

      if (query.text.includes('from "users"')) {
        return Promise.resolve({
          rows: [
            { id: 1, name: "Ana" },
            { id: 2, name: "Bo" },
          ] as T[],
          rowCount: 2,
        });
      }

      if (
        query.text.includes('from "posts"') &&
        query.text.includes('where "posts"."userId" in')
      ) {
        return Promise.resolve({
          rows: [
            { userId: 1, title: "One" },
            { userId: 1, title: "Two" },
          ] as T[],
          rowCount: 2,
        });
      }

      if (query.text.includes('from "posts"')) {
        return Promise.resolve({
          rows: [{ userId: 1, title: "One" }] as T[],
          rowCount: 1,
        });
      }

      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    execute(): Promise<OrmQueryResult> {
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
  const relationalDb = createDatabase({
    dialect: "postgres",
    driver,
    schema: { users, posts },
    relations: [usersRelations, postsRelations] as const,
  });

  const userRows = await relationalDb.query.users.findMany({
    columns: { name: true },
    with: {
      posts: {
        columns: { title: true },
        orderBy: asc(posts.columns.id),
      },
    },
    orderBy: asc(users.columns.id),
  });
  const firstPost = await relationalDb.query.posts.findFirst({
    columns: { title: true },
    with: { author: { columns: { name: true } } },
  });
  const expectedFirstPost: typeof firstPost = {
    title: "One",
    author: { name: "Ana" },
  };

  assertEquals(userRows, [
    { name: "Ana", posts: [{ title: "One" }, { title: "Two" }] },
    { name: "Bo", posts: [] },
  ]);
  assertEquals(firstPost, expectedFirstPost);
  assertEquals(queries, [
    {
      text:
        'select "users"."name" as "name", "users"."id" as "id" from "users" order by "users"."id" asc',
      params: [],
    },
    {
      text:
        'select "posts"."title" as "title", "posts"."userId" as "userId" from "posts" where "posts"."userId" in ($1, $2) order by "posts"."id" asc',
      params: [1, 2],
    },
    {
      text:
        'select "posts"."title" as "title", "posts"."userId" as "userId" from "posts" limit $1',
      params: [1],
    },
    {
      text:
        'select "users"."name" as "name", "users"."id" as "id" from "users" where "users"."id" in ($1)',
      params: [1],
    },
  ]);
});

// ---------------------------------------------------------------------------
// 4. Typed SQL helpers
// ---------------------------------------------------------------------------

Deno.test("parity: sql tag + raw/identifier/join/empty helpers", () => {
  assertEquals(renderSql(sql`select ${1}`, { dialect: "postgres" }), {
    text: "select $1",
    params: [1],
  });
  assertEquals(renderSql(raw("now()")).text, "now()"); // ~ sql.raw
  assertEquals(
    renderSql(identifier("a.b"), { dialect: "postgres" }).text,
    '"a"."b"', // ~ sql.identifier
  );
  assertEquals(
    renderSql(joinSql([raw("a"), raw("b")], raw(", "))).text,
    "a, b", // ~ sql.join
  );
  assertEquals(renderSql(emptySql()).text, ""); // ~ sql.empty()
});

Deno.test("roadmap: sql.placeholder has no Sisal equivalent yet", () => {
  assertEquals(api.placeholder, undefined);
});

// ---------------------------------------------------------------------------
// 5. Introspection + type inference
// ---------------------------------------------------------------------------

Deno.test("parity: getTableName / getTableColumns", () => {
  assertEquals(orm.getTableName(users), "users");
  assertEquals(
    Object.keys(orm.getTableColumns(users)).sort(),
    ["age", "id", "name"],
  );
});

Deno.test("parity: InferSelect / InferInsert mirror Drizzle's infer types", () => {
  // Compile-time parity (these mirror InferSelectModel / InferInsertModel and
  // t.$inferSelect / t.$inferInsert). The runtime asserts keep the test honest.
  const row: InferSelect<typeof users> = { id: 1, name: "a", age: 7 };
  const insert: InferInsert<typeof users> = { id: 1, name: "a" }; // age optional
  assertEquals(row.id, 1);
  assertEquals(insert.name, "a");
});
