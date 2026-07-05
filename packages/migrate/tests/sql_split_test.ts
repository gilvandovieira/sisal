import { assertEquals } from "@std/assert";
import { splitSqlStatements } from "../mod.ts";

Deno.test("splitSqlStatements: splits on top-level semicolons", () => {
  assertEquals(splitSqlStatements("select 1; select 2;"), [
    "select 1;",
    "select 2;",
  ]);
  // A trailing statement without a terminating `;` is still returned.
  assertEquals(splitSqlStatements("select 1; select 2"), [
    "select 1;",
    "select 2",
  ]);
  // Empty input and whitespace/empty statements yield no statements.
  assertEquals(splitSqlStatements(""), []);
  assertEquals(splitSqlStatements("  ;\n; \t"), []);
});

Deno.test("splitSqlStatements: strings, identifiers, and comments", () => {
  // Semicolons inside single-quoted strings are not terminators.
  assertEquals(splitSqlStatements("insert into t values ('a;b'); select 1;"), [
    "insert into t values ('a;b');",
    "select 1;",
  ]);
  // Escaped quotes ('') inside a string literal.
  assertEquals(splitSqlStatements("select 'it''s; ok'; select 2;"), [
    "select 'it''s; ok';",
    "select 2;",
  ]);
  // Semicolons inside double-quoted identifiers are not terminators.
  assertEquals(splitSqlStatements('select "a;b" from t; select 2;'), [
    'select "a;b" from t;',
    "select 2;",
  ]);
  // Line comments swallow the `;` to end of line.
  assertEquals(
    splitSqlStatements("select 1 -- a; b\n; select 2;"),
    ["select 1 -- a; b\n;", "select 2;"],
  );
  // Block comments swallow internal semicolons.
  assertEquals(
    splitSqlStatements("select 1 /* a; b */; select 2;"),
    ["select 1 /* a; b */;", "select 2;"],
  );
});

Deno.test("splitSqlStatements: dollar-quoted bodies stay whole", () => {
  // `$$ … ; … $$` — a plpgsql body's internal semicolons are not terminators.
  const fn = "create function f() returns int as $$ begin return 1; end; $$ " +
    "language plpgsql;";
  assertEquals(splitSqlStatements(`${fn} select 1;`), [fn, "select 1;"]);

  // Tagged dollar quotes (`$body$ … $body$`) with several internal statements.
  const tagged =
    "create function g() returns void as $body$ begin perform 1; perform 2; " +
    "end; $body$ language plpgsql;";
  assertEquals(
    splitSqlStatements(`${tagged} create table t (id int);`),
    [tagged, "create table t (id int);"],
  );

  // `$1`/`$2` parameter placeholders are not dollar quotes.
  assertEquals(
    splitSqlStatements("update t set a = $1 where id = $2; select 3;"),
    [
      "update t set a = $1 where id = $2;",
      "select 3;",
    ],
  );
});

Deno.test("splitSqlStatements: E'' escape strings keep backslash-escaped quotes (SEC-007)", () => {
  // `\'` inside an escape string is an escaped quote, not a terminator — the
  // `;` after it must not split the statement.
  assertEquals(
    splitSqlStatements("insert into t values (E'a\\';b'); select 2;"),
    ["insert into t values (E'a\\';b');", "select 2;"],
  );
  // A doubled backslash is a literal backslash; the following `'` still closes.
  assertEquals(
    splitSqlStatements("select E'a\\\\'; select 2;"),
    ["select E'a\\\\';", "select 2;"],
  );
  // Lowercase `e'…'` is also an escape string.
  assertEquals(
    splitSqlStatements("select e'x\\';y'; select 2;"),
    ["select e'x\\';y';", "select 2;"],
  );
  // A column/identifier ending in `e` is not an escape-string prefix, so the
  // following literal is a plain string (backslash is literal there).
  assertEquals(
    splitSqlStatements("select code'a'; select 2;").length,
    2,
  );
});

Deno.test("splitSqlStatements: nested block comments swallow internal semicolons (SEC-007)", () => {
  // The inner `*/` must not end the outer comment, so the `;` inside stays
  // hidden and does not split the statement early.
  assertEquals(
    splitSqlStatements("select 1 /* a /* b; */ c; */ + 2; select 3;"),
    ["select 1 /* a /* b; */ c; */ + 2;", "select 3;"],
  );
});
