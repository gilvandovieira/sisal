/**
 * Security-invariant tests for `@sisal/orm`.
 *
 * These pin the safety properties documented in `docs/security.md` so a refactor
 * cannot silently weaken them: values are always bound parameters, identifiers
 * reject injection, the escape hatches stay strict, where-less mutations are
 * blocked, and thrown errors never carry parameter values.
 *
 * @module
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  columns,
  createDatabase,
  defineTable,
  eq,
  identifier,
  type OrmDriver,
  OrmError,
  raw,
  redactSecrets,
  renderSql,
  serializeSqlValue,
  sql,
} from "../mod.ts";

const users = defineTable("users", {
  id: columns.text().primaryKey(),
  email: columns.text().notNull(),
  secret: columns.text(),
});

Deno.test("security: values render as bound parameters, never inlined", () => {
  const payload = "p4ss' OR '1'='1; drop table users; --";
  const rendered = renderSql(
    sql`select * from users where email = ${payload}`,
    { dialect: "postgres" },
  );
  assert(
    !rendered.text.includes("OR '1'='1"),
    `value leaked into SQL text: ${rendered.text}`,
  );
  assert(rendered.text.includes("$1"), "value should be a placeholder");
  assertEquals(rendered.params, [payload]);
});

Deno.test("security: identifier() rejects injection attempts", () => {
  for (
    const bad of [
      'users"; drop table users; --', // embedded double quote
      "col`name", // embedded backtick
      "trailing.", // trailing dot
      "..leading", // empty path segment
      "with\x00null", // control character
    ]
  ) {
    assertThrows(
      () => identifier(bad),
      OrmError,
      undefined,
      `identifier() must reject ${JSON.stringify(bad)}`,
    );
  }
  // A normal dotted path is quoted, not rejected.
  assertEquals(
    renderSql(identifier("users.id"), { dialect: "postgres" }).text,
    '"users"."id"',
  );
});

Deno.test("security: escape hatches stay strict", () => {
  assertThrows(() => raw(123 as unknown as string), OrmError);
  assertThrows(() => serializeSqlValue(sql`fragment`), OrmError);
});

Deno.test("security: where-less update/delete are blocked by default", () => {
  const db = createDatabase({ driver: noopDriver(), dialect: "postgres" });

  assertThrows(
    () => db.update(users).set({ email: "x@example.com" }).toSql(),
    OrmError,
  );
  assertThrows(() => db.delete(users).toSql(), OrmError);

  // The explicit opt-in renders a full-table statement.
  db.update(users).set({ email: "x@example.com" }).unsafeAllowAllRows().toSql();
  db.delete(users).unsafeAllowAllRows().toSql();
});

Deno.test("security: thrown errors never carry parameter values", async () => {
  const secret = "super-secret-token-value";
  const db = createDatabase({ driver: throwingDriver(), dialect: "postgres" });

  let caught: unknown;
  try {
    await db.select().from(users).where(eq(users.columns.secret, secret))
      .execute();
  } catch (error) {
    caught = error;
  }

  assert(caught instanceof OrmError, "expected an OrmError");
  const serialized = JSON.stringify({
    message: caught.message,
    details: caught.details,
  });
  assert(
    !serialized.includes(secret),
    `error leaked the parameter value: ${serialized}`,
  );
});

Deno.test("security: credentials are redacted from errors", () => {
  const dsn = "postgres://app:s3cr3t@db.internal:5432/prod";
  // A driver's connection error often echoes the DSN (with password).
  const wrapped = new OrmError("PostgreSQL connection failed", {
    code: "ORM_CONNECTION_FAILED",
    cause: new Error(`connection refused: ${dsn}`),
  });

  const serialized = JSON.stringify({
    message: wrapped.message,
    cause: (wrapped.cause as Error).message,
  });
  assert(!serialized.includes("s3cr3t"), `secret leaked: ${serialized}`);
  assert(serialized.includes("***"), "expected a redaction marker");

  // redactSecrets is exported for redacting logs/diagnostics too.
  assertEquals(
    redactSecrets("libsql://db.turso.io?authToken=tok_123&x=1"),
    "libsql://db.turso.io?authToken=***&x=1",
  );
  assertEquals(
    redactSecrets("password=hunter2 host=localhost"),
    "password=*** host=localhost",
  );
  // Non-secret text is untouched.
  assertEquals(
    redactSecrets("syntax error near 'select'"),
    "syntax error near 'select'",
  );
});

function noopDriver(): OrmDriver {
  return {
    query: () => Promise.resolve({ rows: [], rowCount: 0 }),
    execute: () => Promise.resolve({ rows: [], rowCount: 0 }),
    close: () => Promise.resolve(),
  };
}

function throwingDriver(): OrmDriver {
  const fail = () => {
    throw new Error("driver failure");
  };
  return {
    query: fail,
    execute: fail,
    close: () => Promise.resolve(),
  };
}
