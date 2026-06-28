import { assertEquals, assertThrows } from "@std/assert";
import {
  asc,
  avg,
  columns,
  count,
  defineTable,
  desc,
  eq,
  gt,
  max,
  min,
  renderSql,
  sum,
} from "../mod.ts";
import { db, users } from "./_fixtures.ts";

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
  const posts = defineTable(
    "posts",
    {
      id: columns.integer().primaryKey(),
      userId: columns.integer().notNull(),
    },
    { naming: "preserve" },
  );
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
