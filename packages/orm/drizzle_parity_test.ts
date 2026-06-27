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
  columns,
  type Condition,
  createDatabase,
  defineTable,
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
  ne,
  not,
  notInArray,
  or,
  raw,
  renderSql,
  sql,
  type SqlDialect,
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
      "between",
      "notBetween",
      "notLike",
      "notIlike",
      "exists",
      "notExists",
      "arrayContains",
      "arrayContained",
      "arrayOverlaps",
      "asc",
      "desc",
      "count",
      "sum",
      "avg",
      "min",
      "max",
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
  for (const name of ["text", "integer", "boolean", "timestamp", "uuid"]) {
    assertEquals(typeof factory[name], "function", `columns.${name}`);
  }
  // Sisal-flavored extras
  for (
    const name of ["varchar", "bigint", "number", "json", "jsonb", "date"]
  ) {
    assertEquals(typeof factory[name], "function", `columns.${name}`);
  }
});

Deno.test("parity: column modifiers (shared, extra, and gaps)", () => {
  const builder = columns.text() as unknown as Record<string, unknown>;
  for (
    const name of ["notNull", "default", "primaryKey", "unique", "references"]
  ) {
    assertEquals(typeof builder[name], "function", `.${name}()`);
  }
  // Sisal-specific modifiers Drizzle lacks
  for (const name of ["nullable", "optional", "named"]) {
    assertEquals(typeof builder[name], "function", `.${name}()`);
  }
  // Drizzle modifiers Sisal has not implemented
  for (
    const name of [
      "$type",
      "$default",
      "$defaultFn",
      "array",
      "$onUpdate",
      "generatedAlwaysAs",
    ]
  ) {
    assertEquals(builder[name], undefined, `.${name}() unexpectedly present`);
  }
});

Deno.test("divergence: columns are NOT NULL by default (Drizzle defaults to nullable)", () => {
  const t = defineTable("t", {
    a: columns.text(), // no .nullable()
    b: columns.text().optional(), // optional() is insert-only, not nullability
  });
  assertEquals(t.columns.a.nullable, false);
  assertEquals(t.columns.b.nullable, false);
  assertEquals(
    defineTable("t2", { a: columns.text().nullable() }).columns.a.nullable,
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

Deno.test("parity: join methods present; advanced builder methods are gaps", () => {
  const select = db.select().from(users) as unknown as Record<string, unknown>;
  assertEquals(typeof select.innerJoin, "function");
  assertEquals(typeof select.leftJoin, "function");
  for (
    const name of ["rightJoin", "fullJoin", "groupBy", "having", "distinct"]
  ) {
    assertEquals(
      select[name],
      undefined,
      `select.${name} unexpectedly present`,
    );
  }
  const insert = db.insert(users) as unknown as Record<string, unknown>;
  for (const name of ["onConflictDoNothing", "onConflictDoUpdate"]) {
    assertEquals(
      insert[name],
      undefined,
      `insert.${name} unexpectedly present`,
    );
  }
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
