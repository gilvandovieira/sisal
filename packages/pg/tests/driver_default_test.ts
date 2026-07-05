/**
 * Pins the `@sisal/pg` URL-driver default (v0.10 CF1): postgres.js
 * (`npm:postgres`, lazily imported) is the default; the pure-JSR
 * `jsr:@db/postgres` stays selectable with `driver: "db-postgres"`.
 * Network-free — postgres.js pools defer their import to the first actual
 * connect, so resolving a connection source touches no driver.
 */
import { assert, assertEquals } from "@std/assert";
import { Pool as DbPostgresPool } from "@db/postgres";
import { DEFAULT_PG_DRIVER, resolvePgDriverKind } from "../mod.ts";
import { resolvePgConnectionSource } from "../src/orm/pool.ts";

const URL = "postgres://postgres:postgres@localhost:5432/unused";

Deno.test("pg driver: postgres.js is the URL default since v0.10", () => {
  assertEquals(DEFAULT_PG_DRIVER, "postgres-js");
  assertEquals(resolvePgDriverKind({}), "postgres-js");
  assertEquals(resolvePgDriverKind({ driver: undefined }), "postgres-js");
  assertEquals(resolvePgDriverKind({ driver: "db-postgres" }), "db-postgres");
  assertEquals(resolvePgDriverKind({ driver: "postgres-js" }), "postgres-js");
});

Deno.test("pg driver: URL sources resolve to lazy, import-free pools", () => {
  // Since NPM-4 both drivers defer their import to the first connect, so neither
  // eagerly constructs the `@db/postgres` `Pool` — resolving a source touches no
  // driver and the module stays loadable under runtimes that reject `jsr:`.
  // Driver *selection* is pinned by `resolvePgDriverKind` above.
  const defaulted = resolvePgConnectionSource({ url: URL });
  assert(defaulted.ownsPool);
  assert(typeof defaulted.pool?.connect === "function");
  assertEquals(defaulted.pool instanceof DbPostgresPool, false);

  const optedOut = resolvePgConnectionSource({
    url: URL,
    driver: "db-postgres",
  });
  assert(optedOut.ownsPool);
  assert(typeof optedOut.pool?.connect === "function");
  assertEquals(optedOut.pool instanceof DbPostgresPool, false);
});
