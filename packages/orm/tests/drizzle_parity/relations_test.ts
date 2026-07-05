import { assertEquals } from "@std/assert";
import {
  asc,
  columns,
  createDatabase,
  defineTable,
  type OrmDriver,
  type OrmQueryResult,
  relations,
  type SqlQuery,
} from "../../mod.ts";
import { users } from "./_fixtures.ts";

Deno.test("parity: relations() + db.query.table.findMany/findFirst with with/columns", async () => {
  const posts = defineTable(
    "posts",
    {
      id: columns.integer().primaryKey(),
      userId: columns.integer().notNull().references("users", "id"),
      title: columns.text().notNull(),
    },
    { naming: "preserve" },
  );
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
