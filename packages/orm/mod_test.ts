import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { validateSchemaSnapshot } from "@sisal/orm";
import {
  and,
  columns,
  createDatabase,
  createSchemaSnapshot,
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
  isColumn,
  isNotNull,
  isNull,
  isSql,
  isTable,
  joinSql,
  like,
  lt,
  lte,
  memoryOrmDriver,
  ne,
  noopOrmDriver,
  normalizeColumnName,
  normalizeTableName,
  not,
  notInArray,
  or,
  OrmError,
  quoteIdentifier,
  raw,
  renderSql,
  serializeSqlValue,
  sql,
  toSql,
} from "./mod.ts";

const users = defineTable("users", {
  id: columns.text().primaryKey(),
  name: columns.text().notNull(),
  email: columns.text().notNull().unique(),
  age: columns.integer().optional(),
  score: columns.number().nullable(),
  active: columns.boolean().default(true),
  profile: columns.json<{ theme: string }>().optional(),
  birthday: columns.date().optional(),
  createdAt: columns.timestamp({ mode: "date" }).default(() => new Date()),
  orgId: columns.uuid().references("organizations", "id"),
}, { naming: "preserve" });

Deno.test("@sisal/orm - Postgres column types map into a valid schema snapshot", () => {
  const accounts = defineTable("accounts", {
    id: columns.uuid().primaryKey(),
    handle: columns.varchar(32).notNull(),
    balance: columns.bigint().notNull(),
    settings: columns.jsonb<{ theme: string }>().optional(),
    createdAt: columns.timestamp({ withTimezone: true, mode: "date" })
      .notNull(),
  }, { naming: "preserve" });

  // Inference: bigint is typed as string (precision-safe); jsonb keeps its generic.
  const insert: InferInsert<typeof accounts> = {
    id: "a_1",
    handle: "lucas",
    balance: "9007199254740993",
    createdAt: new Date(),
  };
  assertEquals(insert.balance, "9007199254740993");

  const snapshot = createSchemaSnapshot({
    dialect: "postgres",
    tables: [accounts],
  });
  const table = snapshot.tables[0];
  const columnType = (name: string) =>
    table.columns.find((column) => column.name === name)!.type;

  assertEquals(columnType("handle"), { kind: "varchar", length: 32 });
  assertEquals(columnType("balance").kind, "bigint");
  assertEquals(columnType("settings").kind, "jsonb");
  assertEquals(columnType("createdAt").kind, "timestamptz");

  // createSchemaSnapshot validates as it builds; re-check to be explicit.
  assertEquals(validateSchemaSnapshot(snapshot), []);
});

Deno.test("@sisal/orm - table columns and inference compile", () => {
  type User = InferSelect<typeof users>;
  type NewUser = InferInsert<typeof users>;

  // `.optional()` is insert-only: a nullable optional column still reads back as
  // `T | null` on select (never `undefined`) — roadmap item 10.
  const selected: User = {
    id: "u_123",
    name: "Lucas",
    email: "lucas@example.com",
    age: null,
    score: null,
    active: true,
    profile: null,
    birthday: null,
    createdAt: new Date(),
    orgId: "org_123",
  };
  const inserted: NewUser = {
    id: "u_123",
    name: "Lucas",
    email: "lucas@example.com",
    score: 1,
    orgId: "org_123",
  };

  assertEquals(selected.id, inserted.id);
  assertEquals(users.columns.orgId.references?.table, "organizations");
  assertEquals(isTable(users), true);
  assertEquals(isColumn(users.columns.id), true);
});

Deno.test("@sisal/orm - SQL fragments render safely", () => {
  const query = sql`select * from ${identifier("users")} where id = ${"u_123"}`;
  const rendered = renderSql(query, { dialect: "postgres" });

  assertEquals(rendered.text, 'select * from "users" where id = $1');
  assertEquals(rendered.params, ["u_123"]);
  assertEquals(renderSql(query).text, 'select * from "users" where id = ?');
  assertEquals(quoteIdentifier("users.id", "mysql"), "`users`.`id`");
  assertEquals(renderSql(joinSql([raw("a"), raw("b")])).text, "a, b");
  assertEquals(renderSql(emptySql()).text, "");
  assertEquals(isSql(query), true);
  assertThrows(() => identifier("bad name"), OrmError);
});

Deno.test("@sisal/orm - conditions render", () => {
  const condition = and(
    eq(users.columns.id, "u_123"),
    ne(users.columns.email, "x@example.com"),
    or(gt(users.columns.age, 18), gte(users.columns.age, 21)),
    lt(users.columns.age, 100),
    lte(users.columns.age, 99),
    like(users.columns.email, "%@example.com"),
    not(isNull(users.columns.name)),
    isNotNull(users.columns.email),
  );
  const rendered = renderSql(toSql(condition), { dialect: "postgres" });

  assert(rendered.text.includes('"users"."id" = $1'));
  assert(rendered.text.includes('not ("users"."name" is null)'));
  assertEquals(rendered.params.length, 7);
});

Deno.test("@sisal/orm - inArray, notInArray, and ilike predicates", () => {
  const inRendered = renderSql(
    toSql(inArray(users.columns.id, ["a", "b", "c"])),
    { dialect: "postgres" },
  );
  assertEquals(inRendered.text, '"users"."id" in ($1, $2, $3)');
  assertEquals(inRendered.params, ["a", "b", "c"]);

  const notInRendered = renderSql(
    toSql(notInArray(users.columns.id, [1, 2])),
    { dialect: "postgres" },
  );
  assert(notInRendered.text.includes('"users"."id" not in ($1, $2)'));

  const ilikeRendered = renderSql(
    toSql(ilike(users.columns.email, "%@Example.com")),
    { dialect: "postgres" },
  );
  assertEquals(ilikeRendered.text, '"users"."email" ilike $1');

  // Empty arrays become safe constants instead of invalid SQL.
  assertEquals(renderSql(toSql(inArray(users.columns.id, []))).text, "1 = 0");
  assertEquals(
    renderSql(toSql(notInArray(users.columns.id, []))).text,
    "1 = 1",
  );
});

Deno.test("@sisal/orm - CTEs and set operations build SQL and execute", async () => {
  const db = createDatabase({ driver: noopOrmDriver(), dialect: "postgres" });

  const a = db.select({ id: users.columns.id }).from(users)
    .where(eq(users.columns.id, "u_1"));
  const b = db.select({ id: users.columns.id }).from(users)
    .where(eq(users.columns.id, "u_2"));

  // Set-operation operands are not parenthesized (portable Postgres/SQLite).
  assertEquals(
    renderSql(a.union(b).toSql(), { dialect: "postgres" }).text,
    'select "users"."id" as "id" from "users" where "users"."id" = $1 union ' +
      'select "users"."id" as "id" from "users" where "users"."id" = $2',
  );
  assertEquals(await a.intersect(b).execute(), []);

  // A CTE infers its columns from the inner projection and renders a WITH prefix.
  const recent = db.$with("recent").as(
    db.select({ id: users.columns.id, email: users.columns.email }).from(users),
  );
  const cte = db.with(recent).select({ id: recent.id }).from(recent).limit(10);
  assertEquals(
    renderSql(cte.toSql(), { dialect: "postgres" }).text,
    'with "recent" as (select "users"."id" as "id", "users"."email" as ' +
      '"email" from "users") select "recent"."id" as "id" from "recent" ' +
      "limit $1",
  );
  assertEquals(await cte.execute(), []);

  // with() rejects values that were not produced by db.$with(...).as(...).
  assertThrows(() => db.with({} as never), Error);
});

Deno.test("@sisal/orm - builders generate SQL and execute with noop driver", async () => {
  const db = createDatabase({ driver: noopOrmDriver(), dialect: "postgres" });

  const selectSql = db.select()
    .from(users)
    .where(eq(users.columns.id, "u_123"))
    .orderBy(users.columns.email, "desc")
    .limit(1)
    .offset(0)
    .toSql();
  assertEquals(
    renderSql(selectSql, { dialect: "postgres" }).text,
    'select * from "users" where "users"."id" = $1 order by "users"."email" desc limit $2 offset $3',
  );

  const insert = await db.insert(users).values({
    id: "u_123",
    name: "Lucas",
    email: "lucas@example.com",
    score: 1,
    orgId: "org_123",
  }).returning().execute();
  assertEquals(insert.rowCount, 0);

  const updateSql = db.update(users)
    .set({ name: "Lucas Vieira" })
    .where(eq(users.columns.id, "u_123"))
    .returning()
    .toSql();
  assert(renderSql(updateSql).text.includes('update "users" set "name" = ?'));

  const deleteSql = db.delete(users)
    .where(eq(users.columns.id, "u_123"))
    .returning()
    .toSql();
  assert(renderSql(deleteSql).text.includes('delete from "users" where'));
});

Deno.test("@sisal/orm - update and delete require where by default", () => {
  const db = createDatabase();

  assertThrows(
    () => db.update(users).set({ name: "all" }).toSql(),
    OrmError,
  );
  assertThrows(() => db.delete(users).toSql(), OrmError);

  const updateSql = renderSql(
    db.update(users).set({ name: "all" }).unsafeAllowAllRows().toSql(),
  );
  const deleteSql = renderSql(db.delete(users).unsafeAllowAllRows().toSql());

  assertEquals(updateSql.text, 'update "users" set "name" = ?');
  assertEquals(deleteSql.text, 'delete from "users"');
});

Deno.test("@sisal/orm - createSchemaSnapshot maps table metadata", () => {
  const snapshot = createSchemaSnapshot({
    dialect: "postgres",
    tables: [users],
  });
  const table = snapshot.tables[0];

  assertEquals(snapshot.version, 2);
  assertEquals(snapshot.dialect, "postgres");
  assertEquals(table.name, "users");
  assertEquals(table.primaryKey?.columns, ["id"]);
  assertEquals(
    table.uniqueConstraints?.some((constraint) =>
      constraint.columns[0] === "email"
    ),
    true,
  );
  assertEquals(
    table.foreignKeys?.[0],
    {
      columns: ["orgId"],
      references: { table: "organizations", columns: ["id"] },
    },
  );
  assertEquals(
    table.columns.find((column) => column.name === "active")?.default,
    { kind: "literal", value: true },
  );
  assertEquals(
    table.columns.find((column) => column.name === "createdAt")?.default,
    undefined,
  );
});

Deno.test("@sisal/orm - createSchemaSnapshot output order is deterministic", () => {
  const posts = defineTable("posts", {
    id: columns.text().primaryKey(),
    userId: columns.text().references("users", "id"),
  }, { naming: "preserve" });
  const snapshot = createSchemaSnapshot({
    tables: [users, posts],
  });

  assertEquals(snapshot.tables.map((table) => table.name), ["posts", "users"]);
});

Deno.test("@sisal/orm - database query transaction and helpers", async () => {
  const db = createDatabase({ driver: memoryOrmDriver() });
  const result = await db.execute(sql`select ${1}`);
  assertEquals(result.rows, []);

  const txResult = await db.transaction(async (tx) => {
    await tx.query(sql`select ${1}`);
    return 1;
  });
  assertEquals(txResult, 1);

  assertEquals(normalizeTableName("public.users"), "public.users");
  assertEquals(normalizeColumnName("email"), "email");
  assertEquals(serializeSqlValue(undefined), null);
  assertEquals(serializeSqlValue(new Date(0)) instanceof Date, true);
  assertExists(toSql(sql`select 1`));
  await assertRejects(
    () =>
      createDatabase({
        driver: {
          query: () => Promise.reject(new Error("boom")),
          execute: () => Promise.reject(new Error("boom")),
        },
      }).query(sql`select 1`),
    OrmError,
  );
});

Deno.test("@sisal/orm - joins and projected select generate SQL", () => {
  const db = createDatabase({ driver: noopOrmDriver(), dialect: "postgres" });
  const posts = defineTable("posts", {
    id: columns.uuid().primaryKey(),
    userId: columns.uuid().notNull(),
    title: columns.text().notNull(),
  }, { naming: "preserve" });

  const projected = db.select({
    userId: users.columns.id,
    title: posts.columns.title,
  })
    .from(users)
    .leftJoin(posts, eq(posts.columns.userId, users.columns.id))
    .where(eq(users.columns.id, "u_1"))
    .toSql();

  const rendered = renderSql(projected, { dialect: "postgres" });
  assertEquals(
    rendered.text,
    'select "users"."id" as "userId", "posts"."title" as "title" ' +
      'from "users" left join "posts" on "posts"."userId" = "users"."id" ' +
      'where "users"."id" = $1',
  );
  assertEquals(rendered.params, ["u_1"]);

  // Column-to-column equality powers the inner-join ON clause.
  const inner = db.select().from(users).innerJoin(
    posts,
    eq(posts.columns.userId, users.columns.id),
  ).toSql();
  assert(
    renderSql(inner).text.includes(
      'inner join "posts" on "posts"."userId" = "users"."id"',
    ),
  );
});

Deno.test("@sisal/orm - projected and star returning", () => {
  const db = createDatabase({ driver: noopOrmDriver(), dialect: "postgres" });

  const insert = db.insert(users).values({
    id: "u_1",
    name: "Alice",
    email: "a@example.com",
    score: null,
    orgId: "org_1",
  }).returning({ id: users.columns.id }).toSql();
  assert(renderSql(insert).text.includes('returning "users"."id" as "id"'));

  const update = db.update(users).set({ name: "Bob" }).where(
    eq(users.columns.id, "u_1"),
  ).returning({ name: users.columns.name }).toSql();
  assert(renderSql(update).text.includes('returning "users"."name" as "name"'));

  const removed = db.delete(users).where(eq(users.columns.id, "u_1"))
    .returning().toSql();
  assert(renderSql(removed).text.includes("returning *"));
});
