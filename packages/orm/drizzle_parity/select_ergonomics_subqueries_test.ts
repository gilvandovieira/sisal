import { assertEquals, assertThrows } from "@std/assert";
import {
  asc,
  columns,
  count,
  countDistinct,
  createDatabase,
  defineTable,
  eq,
  gt,
  inArray,
  type OrmDriver,
  type OrmQueryResult,
  renderSql,
  type SqlQuery,
} from "../mod.ts";
import { api, db, users } from "./_fixtures.ts";

const posts = defineTable(
  "posts",
  {
    id: columns.integer().primaryKey(),
    userId: columns.integer().notNull(),
  },
  { naming: "preserve" },
);

Deno.test("parity: .distinctOn(...) renders Postgres DISTINCT ON", () => {
  const query = db.select().from(users)
    .distinctOn(users.columns.name)
    .orderBy(asc(users.columns.name))
    .toSql();
  assertEquals(
    renderSql(query, { dialect: "postgres" }).text,
    'select distinct on ("users"."name") * from "users" ' +
      'order by "users"."name" asc',
  );
});

Deno.test("parity: .for() row locking (update/share, skipLocked/noWait/of)", () => {
  const base = db.select().from(users);
  assertEquals(
    renderSql(base.for("update").toSql(), { dialect: "postgres" }).text,
    'select * from "users" for update',
  );
  assertEquals(
    renderSql(base.for("share", { skipLocked: true }).toSql(), {
      dialect: "postgres",
    }).text,
    'select * from "users" for share skip locked',
  );
  assertEquals(
    renderSql(base.for("update", { noWait: true }).toSql(), {
      dialect: "postgres",
    }).text,
    'select * from "users" for update nowait',
  );
  assertEquals(
    renderSql(base.for("update", { of: users }).toSql(), {
      dialect: "postgres",
    }).text,
    'select * from "users" for update of "users"',
  );
  // skipLocked and noWait are mutually exclusive.
  assertThrows(() => base.for("update", { skipLocked: true, noWait: true }));
});

Deno.test("parity: countDistinct(column) aggregate", () => {
  assertEquals(typeof api.countDistinct, "function", "countDistinct exported");
  const query = db.select({ n: countDistinct(users.columns.name) })
    .from(users).toSql();
  assertEquals(
    renderSql(query, { dialect: "postgres" }).text,
    'select count(distinct "users"."name") as "n" from "users"',
  );
});

Deno.test("parity: subquery as a derived table via .as(alias)", () => {
  const recent = db.select({ id: users.columns.id, age: users.columns.age })
    .from(users).where(gt(users.columns.age, 18)).as("recent");
  // Derived-table columns are referenceable (recent.id) and qualify by alias.
  const query = db.select({ id: recent.id }).from(recent).toSql();
  assertEquals(
    renderSql(query, { dialect: "postgres" }).text,
    'select "recent"."id" as "id" from (select "users"."id" as "id", ' +
      '"users"."age" as "age" from "users" where "users"."age" > $1) ' +
      'as "recent"',
  );
});

Deno.test("parity: scalar subquery in projection and where", () => {
  const projected = db.select({
    name: users.columns.name,
    posts: db.select({ c: count() }).from(posts)
      .where(eq(posts.columns.userId, users.columns.id)),
  }).from(users).toSql();
  assertEquals(
    renderSql(projected, { dialect: "postgres" }).text,
    'select "users"."name" as "name", (select count(*) as "c" from "posts" ' +
      'where "posts"."userId" = "users"."id") as "posts" from "users"',
  );

  const filtered = db.select().from(users)
    .where(eq(
      users.columns.id,
      db.select({ id: posts.columns.userId })
        .from(posts).limit(1),
    ))
    .toSql();
  assertEquals(
    renderSql(filtered, { dialect: "postgres" }).text,
    'select * from "users" where "users"."id" = ' +
      '(select "posts"."userId" as "id" from "posts" limit $1)',
  );
});

Deno.test("parity: inArray(col, subquery) renders IN (select ...)", () => {
  const query = db.select().from(users)
    .where(inArray(
      users.columns.id,
      db.select({ userId: posts.columns.userId }).from(posts),
    ))
    .toSql();
  assertEquals(
    renderSql(query, { dialect: "postgres" }).text,
    'select * from "users" where "users"."id" in ' +
      '(select "posts"."userId" as "userId" from "posts")',
  );
});

Deno.test("parity: db.$count(table, where?) returns a number", async () => {
  const captured: SqlQuery[] = [];
  const driver: OrmDriver = {
    query<T = unknown>(query: SqlQuery): Promise<OrmQueryResult<T>> {
      captured.push(query);
      return Promise.resolve(
        { rows: [{ count: 7 }] as unknown as T[] },
      );
    },
    execute(query: SqlQuery): Promise<OrmQueryResult> {
      captured.push(query);
      return Promise.resolve({ rows: [] });
    },
  };
  const counted = createDatabase({ dialect: "postgres", driver });
  const total = await counted.$count(users, gt(users.columns.age, 18));
  assertEquals(total, 7);
  assertEquals(
    captured[0].text,
    'select count(*) as "count" from "users" where "users"."age" > $1',
  );
});
