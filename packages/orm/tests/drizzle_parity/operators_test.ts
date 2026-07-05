import { assertEquals, assertThrows } from "@std/assert";
import {
  and,
  arrayContained,
  arrayContains,
  arrayOverlaps,
  between,
  columns,
  defineTable,
  eq,
  exists,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  not,
  notBetween,
  notExists,
  notIlike,
  notInArray,
  notLike,
  or,
} from "../../mod.ts";
import { db, render, users } from "./_fixtures.ts";

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

Deno.test("parity: exists / notExists (subquery predicates)", () => {
  const sub = db.select({ one: users.columns.id }).from(users)
    .where(eq(users.columns.id, 1));
  assertEquals(
    render(exists(sub)).text,
    'exists (select "users"."id" as "one" from "users" where "users"."id" = $1)',
  );
  assertEquals(
    render(notExists(sub)).text,
    'not exists (select "users"."id" as "one" from "users" ' +
      'where "users"."id" = $1)',
  );
  // exists/notExists require a select subquery, not an array.
  assertThrows(() => exists([1, 2] as unknown as never));
});

Deno.test("parity: arrayContains / arrayContained / arrayOverlaps (Postgres)", () => {
  const articles = defineTable("articles", {
    id: columns.integer().primaryKey(),
    tags: columns.text().array(),
  });
  const contains = render(arrayContains(articles.columns.tags, ["a", "b"]));
  assertEquals(contains.text, '"articles"."tags" @> $1');
  assertEquals(contains.params, [["a", "b"]]);
  assertEquals(
    render(arrayContained(articles.columns.tags, ["a"])).text,
    '"articles"."tags" <@ $1',
  );
  assertEquals(
    render(arrayOverlaps(articles.columns.tags, ["a"])).text,
    '"articles"."tags" && $1',
  );
});
