/**
 * Pins the `@sisal/pg` URL-driver default (v0.10 CF1): postgres.js
 * (`npm:postgres`, lazily imported) is the default; the pure-JSR
 * `jsr:@db/postgres` stays selectable with `driver: "db-postgres"`.
 * Network-free — postgres.js pools defer their import to the first actual
 * connect, so resolving a connection source touches no driver.
 */
import { assert, assertEquals } from "@std/assert";
import { Pool as DbPostgresPool } from "@db/postgres";
import { DEFAULT_PG_DRIVER, resolvePgDriverKind } from "./mod.ts";
import { resolvePgConnectionSource } from "./orm/pool.ts";

const URL = "postgres://postgres:postgres@localhost:5432/unused";

Deno.test("pg driver: postgres.js is the URL default since v0.10", () => {
  assertEquals(DEFAULT_PG_DRIVER, "postgres-js");
  assertEquals(resolvePgDriverKind({}), "postgres-js");
  assertEquals(resolvePgDriverKind({ driver: undefined }), "postgres-js");
  assertEquals(resolvePgDriverKind({ driver: "db-postgres" }), "db-postgres");
  assertEquals(resolvePgDriverKind({ driver: "postgres-js" }), "postgres-js");
});

Deno.test("pg driver: a URL source defaults to the postgres.js pool", () => {
  // The postgres.js pool is a plain lazy wrapper; @db/postgres is a class
  // instance. Nothing connects here — construction is import-free.
  const defaulted = resolvePgConnectionSource({ url: URL });
  assert(defaulted.ownsPool);
  assertEquals(defaulted.pool instanceof DbPostgresPool, false);

  const optedOut = resolvePgConnectionSource({
    url: URL,
    driver: "db-postgres",
  });
  assertEquals(optedOut.pool instanceof DbPostgresPool, true);
});
