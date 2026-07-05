/**
 * Pins the postgres.js pool's prepared-statement threading (perf fix): Sisal
 * runs queries through `reserved.unsafe(text, params, { prepare })`, and the
 * `prepare` flag must come from the pool option (default `true`, `false` for
 * PgBouncer/Neon transaction pooling). Without it, Postgres re-parses+plans
 * every query — the ~35µs/query overhead measured in
 * `perf/ORM_EXECUTE_PROFILE.md`.
 *
 * Network-free: a fake postgres.js handle is injected into
 * `createPostgresJsPool`, so no `npm:postgres` import and no database.
 */
import { assertEquals } from "@std/assert";
import { createPostgresJsPool } from "../../src/orm/postgres_js_pool.ts";

interface UnsafeCall {
  readonly query: string;
  readonly args?: readonly unknown[];
  readonly options?: { readonly prepare?: boolean };
}

/** A fake postgres.js handle recording every `unsafe()` call's options. */
function fakeSql(record: UnsafeCall[]) {
  const reserved = {
    unsafe(
      query: string,
      args?: readonly unknown[],
      options?: { readonly prepare?: boolean },
    ) {
      record.push({ query, args, options });
      const rows: Record<string, unknown>[] = [{ id: 1 }];
      return Promise.resolve(
        Object.assign(rows, {
          count: 1,
          columns: [{ name: "id", type: 23 }],
        }),
      );
    },
    release() {},
  };
  return {
    reserve: () => Promise.resolve(reserved),
    end: () => Promise.resolve(),
  };
}

Deno.test("postgres.js pool: unsafe() prepares statements by default", async () => {
  const calls: UnsafeCall[] = [];
  const pool = createPostgresJsPool(
    { url: "postgres://u:p@localhost/db" },
    fakeSql(calls),
  );
  const client = await pool.connect();
  await client.queryObject("select $1", [1]);
  client.release?.();
  await pool.end?.();

  assertEquals(calls.length, 1);
  assertEquals(calls[0].options, { prepare: true });
  assertEquals(calls[0].args, [1]);
});

Deno.test("postgres.js pool: prepare:false disables prepared statements", async () => {
  const calls: UnsafeCall[] = [];
  const pool = createPostgresJsPool(
    { url: "postgres://u:p@localhost/db", prepare: false },
    fakeSql(calls),
  );
  const client = await pool.connect();
  await client.queryObject("select 1");
  client.release?.();
  await pool.end?.();

  assertEquals(calls[0].options, { prepare: false });
});
