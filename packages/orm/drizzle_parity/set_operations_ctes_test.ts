import { assertEquals } from "@std/assert";
import { asc, eq, gt, renderSql } from "../mod.ts";
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
