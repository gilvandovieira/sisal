import { assertEquals, assertThrows } from "@std/assert";
import {
  asc,
  columns,
  defineTable,
  eq,
  gt,
  OrmError,
  renderSql,
} from "../mod.ts";
import { db, users } from "./_fixtures.ts";

Deno.test("parity: set operations (union/unionAll/intersect/except)", () => {
  const a = db.select({ id: users.columns.id }).from(users)
    .where(gt(users.columns.age, 18));
  const b = db.select({ id: users.columns.id }).from(users)
    .where(eq(users.columns.id, 1));

  // All six fluent set-operation methods exist on the select builder.
  for (
    const name of [
      "union",
      "unionAll",
      "intersect",
      "intersectAll",
      "except",
      "exceptAll",
    ]
  ) {
    assertEquals(
      typeof (a as unknown as Record<string, unknown>)[name],
      "function",
      `.${name}() - move its row in docs/drizzle-parity.md if removed`,
    );
  }

  assertEquals(
    renderSql(a.union(b).toSql(), { dialect: "postgres" }).text,
    'select "users"."id" as "id" from "users" where "users"."age" > $1 union ' +
      'select "users"."id" as "id" from "users" where "users"."id" = $2',
  );

  // Trailing orderBy/limit bind to the whole compound; operands are unwrapped
  // so the same SQL is valid on Postgres and SQLite.
  assertEquals(
    renderSql(
      a.unionAll(b).orderBy(asc(users.columns.id)).limit(5).toSql(),
      { dialect: "postgres" },
    ).text,
    'select "users"."id" as "id" from "users" where "users"."age" > $1 ' +
      'union all select "users"."id" as "id" from "users" where ' +
      '"users"."id" = $2 order by "users"."id" asc limit $3',
  );

  assertEquals(
    renderSql(a.intersect(b).toSql(), { dialect: "sqlite" }).text,
    'select "users"."id" as "id" from "users" where "users"."age" > ? ' +
      'intersect select "users"."id" as "id" from "users" where ' +
      '"users"."id" = ?',
  );
});

Deno.test("parity: common table expressions (db.$with / db.with)", () => {
  assertEquals(typeof db.$with, "function", "db.$with");
  assertEquals(typeof db.with, "function", "db.with");

  const adults = db.$with("adults").as(
    db.select({ id: users.columns.id, age: users.columns.age })
      .from(users).where(gt(users.columns.age, 18)),
  );
  // CTE columns are inferred from the inner projection and usable as refs.
  const query = db.with(adults).select({ id: adults.id }).from(adults)
    .orderBy(asc(adults.id));

  assertEquals(
    renderSql(query.toSql(), { dialect: "postgres" }).text,
    'with "adults" as (select "users"."id" as "id", "users"."age" as "age" ' +
      'from "users" where "users"."age" > $1) select "adults"."id" as "id" ' +
      'from "adults" order by "adults"."id" asc',
  );
});

Deno.test("parity: data-modifying CTE (INSERT … RETURNING in WITH)", () => {
  // Roadmap item 12: an INSERT/UPDATE/DELETE … RETURNING can be a CTE body,
  // and the WITH chain terminates in a SELECT that reads its RETURNING columns.
  const logs = defineTable("logs", {
    id: columns.integer().primaryKey(),
    msg: columns.text().notNull(),
  }, { naming: "preserve" });

  const inserted = db.$with("inserted").as(
    db.insert(logs).values({ id: 1, msg: "hi" }).returning({
      id: logs.columns.id,
    }),
  );
  const query = db.with(inserted).select({ id: inserted.id }).from(inserted);

  assertEquals(
    renderSql(query.toSql(), { dialect: "postgres" }).text,
    'with "inserted" as (insert into "logs" ("id", "msg") values ($1, $2) ' +
      'returning "logs"."id" as "id") select "inserted"."id" as "id" ' +
      'from "inserted"',
  );

  // Data-modifying CTEs are PostgreSQL-only: the SQLite family rejects
  // INSERT/UPDATE/DELETE inside WITH, so rendering throws a typed error.
  assertThrows(
    () => renderSql(query.toSql(), { dialect: "sqlite" }),
    OrmError,
    "data-modifying CTE",
  );

  // A data-modifying CTE body must expose columns via `.returning()`.
  assertThrows(
    () => db.$with("x").as(db.insert(logs).values({ id: 2, msg: "no" })),
    OrmError,
    "requires .returning()",
  );
});
