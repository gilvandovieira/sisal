/**
 * Tests for the typed database-function caller (`defineFunction` + `db.call`):
 * rendered SQL and parameter order, casts derived from argument column types,
 * scalar vs `RETURNS TABLE` shapes, `.execute()`/`.one()`, and validation.
 */
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  columns,
  createDatabase,
  defineFunction,
  type OrmDriver,
  type OrmQueryResult,
  renderSql,
  type Sql,
  type SqlQuery,
} from "./mod.ts";

const db = createDatabase({ dialect: "postgres" });

function renderText(query: Sql): string {
  return renderSql(query, { dialect: "postgres" }).text;
}

// A driver that returns canned rows for every query.
function rowsDriver(rows: Array<Record<string, unknown>>): OrmDriver {
  return {
    query<T>(_query: SqlQuery): Promise<OrmQueryResult<T>> {
      return Promise.resolve({ rows: rows as T[], rowCount: rows.length });
    },
    execute(_query: SqlQuery): Promise<OrmQueryResult> {
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
}

const votePost = defineFunction("app.vote_post", {
  args: {
    postId: columns.uuid(),
    userId: columns.uuid(),
    value: columns.smallint(),
  },
  returns: {
    id: columns.uuid().notNull(),
    score: columns.integer().notNull(),
    upvotes: columns.integer().notNull(),
    downvotes: columns.integer().notNull(),
    hot_score: columns.doublePrecision().notNull(),
  },
});

Deno.test("functions: RETURNS TABLE renders select * with casts + bound params", () => {
  const rendered = renderSql(
    db.call(votePost, { postId: "p1", userId: "u1", value: -1 }).toSql(),
    { dialect: "postgres" },
  );
  assertEquals(
    rendered.text,
    'select * from "app"."vote_post"($1::uuid, $2::uuid, $3::smallint)',
  );
  // Parameters bind in declared argument order.
  assertEquals(rendered.params, ["p1", "u1", -1]);
});

Deno.test("functions: scalar return renders select fn(...) as result", () => {
  const hotScore = defineFunction("app.calculate_hot_score", {
    args: {
      score: columns.integer(),
      createdAt: columns.timestamp({ mode: "date" }),
    },
    returns: columns.doublePrecision(),
  });
  assertEquals(
    renderText(db.call(hotScore, { score: 5, createdAt: new Date(0) }).toSql()),
    'select "app"."calculate_hot_score"($1::integer, $2::timestamp) as "result"',
  );
});

Deno.test("functions: no-arg function renders an empty call list", () => {
  const now = defineFunction("now", {
    returns: columns.timestamp({ withTimezone: true }),
  });
  assertEquals(
    renderText(db.call(now, {}).toSql()),
    'select "now"() as "result"',
  );
});

Deno.test("functions: casts cover varchar(n), numeric, double, and arrays", () => {
  const fn = defineFunction("f", {
    args: {
      a: columns.varchar(10),
      b: columns.numeric(10, 2),
      c: columns.doublePrecision(),
      d: columns.uuid().array(),
    },
    returns: columns.integer(),
  });
  assertEquals(
    renderText(
      db.call(fn, { a: "x", b: "1.5", c: 1, d: ["u1", "u2"] }).toSql(),
    ),
    'select "f"($1::varchar(10), $2::numeric(10, 2), $3::double precision, ' +
      '$4::uuid[]) as "result"',
  );
});

Deno.test("functions: execute() returns RETURNS TABLE rows", async () => {
  const row = { id: "p1", score: 1, upvotes: 1, downvotes: 0, hot_score: 1.5 };
  const database = createDatabase({
    driver: rowsDriver([row]),
    dialect: "postgres",
  });
  const rows = await database.call(votePost, {
    postId: "p1",
    userId: "u1",
    value: 1,
  }).execute();
  assertEquals(rows, [row]);
});

Deno.test("functions: scalar execute()/one() unwrap the result column", async () => {
  const counter = defineFunction("app.count_votes", {
    args: { postId: columns.uuid() },
    returns: columns.integer(),
  });
  const database = createDatabase({
    driver: rowsDriver([{ result: 42 }]),
    dialect: "postgres",
  });
  assertEquals(await database.call(counter, { postId: "p1" }).execute(), [42]);
  assertEquals(await database.call(counter, { postId: "p1" }).one(), 42);
});

Deno.test("functions: one() throws unless exactly one row", async () => {
  const emptyDb = createDatabase({
    driver: rowsDriver([]),
    dialect: "postgres",
  });
  await assertRejects(() =>
    emptyDb.call(votePost, { postId: "p1", userId: "u1", value: 1 }).one()
  );

  const manyDb = createDatabase({
    driver: rowsDriver([{ id: "a" }, { id: "b" }]),
    dialect: "postgres",
  });
  await assertRejects(() =>
    manyDb.call(votePost, { postId: "p1", userId: "u1", value: 1 }).one()
  );
});

Deno.test("functions: missing argument is rejected", () => {
  assertThrows(() =>
    // deno-lint-ignore no-explicit-any -- intentionally omit a declared arg
    db.call(votePost, { postId: "p1", value: 1 } as any).toSql()
  );
});

Deno.test("functions: defineFunction validates name, args, and returns", () => {
  assertThrows(() =>
    defineFunction('bad"name', { returns: columns.integer() })
  );
  assertThrows(() =>
    // deno-lint-ignore no-explicit-any -- non-builder argument
    defineFunction("f", { args: { a: 1 as any }, returns: columns.integer() })
  );
  assertThrows(() =>
    // deno-lint-ignore no-explicit-any -- empty returns map
    defineFunction("f", { returns: {} as any })
  );
});
