import { assert, assertEquals } from "@std/assert";
import plugin from "./sisal_lint.ts";

function lint(source: string) {
  return Deno.lint.runPlugin(plugin, "sample.ts", source);
}

Deno.test("sisal/no-raw-interpolation flags interpolation into raw()", () => {
  const flagged = lint("raw(`select * from t where id = ${userInput}`);");
  assertEquals(flagged.length, 1);
  assertEquals(flagged[0].id, "sisal/no-raw-interpolation");
  assert(flagged[0].message.includes("parameterization"));
});

Deno.test("sisal/no-raw-interpolation leaves safe forms alone", () => {
  // Static raw string — fine.
  assertEquals(lint('raw("drop table if exists t");').length, 0);
  // The sql template parameterizes values — fine.
  assertEquals(lint("sql`select * from t where id = ${value}`;").length, 0);
  // execute() is the general runner; not targeted by this rule.
  assertEquals(lint("db.execute(`create table ${name} (id int)`);").length, 0);
  // raw() with no interpolation — fine.
  assertEquals(lint("raw(`order by created_at`);").length, 0);
});
