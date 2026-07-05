import { assertEquals, assertThrows } from "@std/assert";
import {
  and,
  createDatabase,
  emptySql,
  eq,
  gt,
  identifier,
  isSql,
  joinSql,
  type OrmDriver,
  type OrmQueryResult,
  placeholder,
  raw,
  renderSql,
  sql,
  type SqlQuery,
  toSql,
} from "../../mod.ts";
import { api, users } from "./_fixtures.ts";

Deno.test("parity: sql tag + raw/identifier/join/empty helpers", () => {
  assertEquals(renderSql(sql`select ${1}`, { dialect: "postgres" }), {
    text: "select $1",
    params: [1],
  });
  assertEquals(renderSql(raw("now()")).text, "now()"); // ~ sql.raw
  assertEquals(
    renderSql(identifier("a.b"), { dialect: "postgres" }).text,
    '"a"."b"', // ~ sql.identifier
  );
  assertEquals(
    renderSql(joinSql([raw("a"), raw("b")], raw(", "))).text,
    "a, b", // ~ sql.join
  );
  assertEquals(renderSql(emptySql()).text, ""); // ~ sql.empty()
});

Deno.test("parity: placeholder() is a deferred parameter slot (~ sql.placeholder)", () => {
  assertEquals(typeof api.placeholder, "function", "placeholder exported");
  // A placeholder is a sql fragment usable inside the sql tag / operators.
  assertEquals(isSql(placeholder("id")), true);
  // Rendering one without binding it (no prepare) is refused, not silently
  // emitted as an empty/!null parameter.
  assertThrows(() =>
    renderSql(sql`select ${placeholder("id")}`, { dialect: "postgres" })
  );
  assertThrows(() =>
    renderSql(toSql(eq(users.columns.id, placeholder("id"))), {
      dialect: "postgres",
    })
  );
  assertThrows(() => placeholder(""));
});

Deno.test("parity: prepared statement (.prepare/.execute) binds placeholders", async () => {
  const captured: SqlQuery[] = [];
  const driver: OrmDriver = {
    query<T = unknown>(query: SqlQuery): Promise<OrmQueryResult<T>> {
      captured.push(query);
      return Promise.resolve({
        rows: [{ id: 1, name: "Ana", age: 30 }] as T[],
        rowCount: 1,
      });
    },
    execute(query: SqlQuery): Promise<OrmQueryResult> {
      captured.push(query);
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
  const prepared = createDatabase({ dialect: "postgres", driver });
  const stmt = prepared.select().from(users)
    .where(and(
      eq(users.columns.id, placeholder("id")),
      gt(users.columns.age, placeholder("minAge")),
    ))
    .prepare("usersById");

  assertEquals(typeof stmt.execute, "function", ".prepare() returns a query");
  assertEquals(stmt.name, "usersById");

  // The plan is rendered once; each call binds fresh values into the slots.
  assertEquals(stmt.toSql({ id: 1, minAge: 18 }), {
    text: 'select * from "users" where ("users"."id" = $1) and ' +
      '("users"."age" > $2)',
    params: [1, 18],
  });

  const rows = await stmt.execute({ id: 1, minAge: 18 });
  assertEquals(rows, [{ id: 1, name: "Ana", age: 30 }]);
  await stmt.execute({ id: 2, minAge: 21 });
  assertEquals(captured[1].params, [2, 21]);
  assertEquals(captured[1].text, captured[0].text);

  // A missing placeholder value is an error at bind time.
  assertThrows(() => stmt.toSql({ id: 1 }));
});
