import { assertEquals } from "@std/assert";
import {
  getTableColumns,
  getTableName,
  type InferInsert,
  type InferSelect,
} from "../../mod.ts";
import { users } from "./_fixtures.ts";

Deno.test("parity: getTableName / getTableColumns", () => {
  assertEquals(getTableName(users), "users");
  assertEquals(
    Object.keys(getTableColumns(users)).sort(),
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
