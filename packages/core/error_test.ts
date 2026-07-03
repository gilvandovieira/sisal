/**
 * Redaction tests for the shared error primitives: pattern coverage
 * ([SEC-011](../../docs/security.md#sec-011)) and deep sanitization of a
 * preserved driver cause ([SEC-010](../../docs/security.md#sec-010)).
 *
 * @module
 */
import { assert, assertEquals } from "@std/assert";
import {
  OrmError,
  redactErrorCause,
  redactSecrets,
  SisalError,
} from "./mod.ts";

Deno.test("redactSecrets: masks encryptionKey and other credential params", () => {
  assertEquals(
    redactSecrets("encryptionKey=abc123 host=localhost"),
    "encryptionKey=*** host=localhost",
  );
  assertEquals(
    redactSecrets("encryption_key: 'super-secret'"),
    "encryption_key: ***",
  );
});

Deno.test("redactSecrets: masks a URL password containing @ or /", () => {
  assert(
    !redactSecrets("postgres://app:p@ss/w0rd@db.host:5432/prod").includes(
      "p@ss/w0rd",
    ),
    "a password with @ and / must not leak",
  );
  // A single reserved char still redacts and keeps the host intact.
  assertEquals(
    redactSecrets("mysql://u:pa/ssword@db.host:3306/app"),
    "mysql://u:***@db.host:3306/app",
  );
  assertEquals(
    redactSecrets("postgres://app:s3cr3t@db.host:5432/prod"),
    "postgres://app:***@db.host:5432/prod",
  );
});

Deno.test("redactSecrets: masks SQL grant/role credentials", () => {
  assertEquals(
    redactSecrets("CREATE USER app IDENTIFIED BY 'hunter2'"),
    "CREATE USER app IDENTIFIED BY ***",
  );
  assertEquals(
    redactSecrets("ALTER ROLE r PASSWORD 'sekret'"),
    "ALTER ROLE r PASSWORD ***",
  );
  // An ordinary column reference is left alone (no quoted literal follows).
  assertEquals(
    redactSecrets("SELECT password FROM users"),
    "SELECT password FROM users",
  );
});

Deno.test("redactErrorCause: drops driver bind values and rendered SQL", () => {
  const driverError = Object.assign(new Error("ER_DUP_ENTRY: duplicate"), {
    code: "ER_DUP_ENTRY",
    errno: 1062,
    sql: "INSERT INTO users (ssn) VALUES ('123-45-6789')",
    parameters: ["123-45-6789", "secret-token"],
  });

  const sanitized = redactErrorCause(driverError) as Record<string, unknown>;
  const serialized = JSON.stringify({
    ...sanitized,
    message: (sanitized as unknown as Error).message,
  });

  assert(!serialized.includes("123-45-6789"), "bind value leaked");
  assert(!serialized.includes("secret-token"), "bind value leaked");
  // Useful non-secret diagnostics survive.
  assertEquals(sanitized.code, "ER_DUP_ENTRY");
  assertEquals(sanitized.errno, 1062);
});

Deno.test("redactErrorCause: masks credential-named properties and DSNs", () => {
  const driverError = Object.assign(new Error("connection failed"), {
    config: {
      host: "db.host",
      password: "s3cr3t",
      uri: "postgres://app:s3cr3t@db.host/prod",
    },
  });

  const serialized = JSON.stringify(redactErrorCause(driverError));
  assert(!serialized.includes("s3cr3t"), "config password/DSN leaked");
  assert(serialized.includes("db.host"), "non-secret host should survive");
});

Deno.test("redactErrorCause: recurses nested cause and AggregateError", () => {
  const inner = Object.assign(new Error("inner"), {
    parameters: ["leaked-value"],
  });
  const aggregate = new AggregateError([inner], "batch failed");
  const wrapped = new Error("outer", { cause: aggregate });

  const serialized = JSON.stringify(
    redactErrorCause(wrapped),
    (_key, value) => value instanceof Error ? { ...value } : value,
  );
  assert(!serialized.includes("leaked-value"), "nested bind value leaked");
});

Deno.test("redactErrorCause: preserves an ordinary clean error's identity", () => {
  const clean = new Error("plain failure");
  assertEquals(redactErrorCause(clean), clean);
});

Deno.test("SisalError: redacts secrets in details.sql", () => {
  const error = new OrmError("migration failed", {
    code: "ORM_EXECUTE_FAILED",
    details: { sql: "CREATE USER app IDENTIFIED BY 'topsecret'" },
  });
  const serialized = JSON.stringify(error.details);
  assert(!serialized.includes("topsecret"), "details.sql leaked a credential");
  assert(serialized.includes("***"), "expected a redaction marker");
});

Deno.test("SisalError: keeps parameterized details.sql intact", () => {
  const error = new SisalError("query failed", {
    details: { sql: "select * from users where id = $1" },
  });
  assertEquals(error.details?.sql, "select * from users where id = $1");
});
