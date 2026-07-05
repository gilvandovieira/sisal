/**
 * Core DDL defense-in-depth ([SEC-016](../../docs/security.md#sec-016)):
 * constraint names are validated as plain identifiers, and a portable DDL
 * expression that carries a bound parameter is rejected rather than silently
 * emitting a dangling `$1` placeholder.
 *
 * @module
 */
import { assertThrows } from "@std/assert";
import {
  check,
  columns,
  createSchemaSnapshot,
  defineTable,
  index,
  OrmError,
  sql,
  unique,
  uniqueIndex,
} from "../mod.ts";

Deno.test("SEC-016: constraint names must be plain identifiers", () => {
  assertThrows(
    () => check("ck; drop table users", sql`1 = 1`),
    OrmError,
    "plain identifier",
  );
  assertThrows(() => index('idx"x'), OrmError, "plain identifier");
  assertThrows(() => uniqueIndex("uq x"), OrmError, "plain identifier");
  assertThrows(() => unique("uq-x"), OrmError, "plain identifier");

  // Conventional snake_case names are accepted.
  check("price_positive_ck", sql`1 = 1`);
  index("posts_feed_idx");
  unique("users_email_uq");
});

Deno.test("SEC-016: portable DDL expressions reject bound parameters", () => {
  const min = 5;
  const products = defineTable("products", {
    id: columns.integer().primaryKey(),
    price: columns.integer().notNull(),
  }, (t) => [check("price_min_ck", sql`${t.price} > ${min}`)]);

  assertThrows(
    () => createSchemaSnapshot({ dialect: "postgres", tables: [products] }),
    OrmError,
    "cannot bind parameters",
  );
});

Deno.test("SEC-016: a literal check expression still snapshots cleanly", () => {
  const products = defineTable("products", {
    id: columns.integer().primaryKey(),
    price: columns.integer().notNull(),
  }, (t) => [check("price_min_ck", sql`${t.price} > 0`)]);

  // No bound params → renders to portable text without throwing.
  createSchemaSnapshot({ dialect: "postgres", tables: [products] });
});
