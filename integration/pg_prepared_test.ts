/**
 * Verifies the prepared-statement perf fix end-to-end against real PostgreSQL:
 * `@sisal/pg`'s postgres.js pool runs `unsafe(text, params, { prepare })`, so by
 * default Sisal's queries become **named prepared statements** (parse+plan once,
 * reuse) — visible in `pg_prepared_statements` — and `prepare: false` (PgBouncer
 * / Neon transaction pooling) suppresses them. See `perf/ORM_EXECUTE_PROFILE.md`.
 *
 * Gated on `DATABASE_URL`; excluded from `deno task test`. Run with:
 *   DATABASE_URL=postgres://postgres:postgres@localhost:55416/sisal \
 *     deno test --allow-net --allow-env --allow-read integration/pg_prepared_test.ts
 */
import { assert, assertEquals } from "@std/assert";
import { createPostgresJsPool } from "@sisal/pg/orm";

const URL = Deno.env.get("DATABASE_URL");
const skip = URL === undefined;

/** Count of named prepared statements on a client's own session. */
async function preparedCount(
  client: { queryObject: (sql: string, args?: unknown[]) => Promise<unknown> },
): Promise<number> {
  const result = await client.queryObject(
    "select count(*)::int as c from pg_prepared_statements",
  ) as { rows: Array<{ c: number }> };
  return Number(result.rows[0]?.c ?? 0);
}

Deno.test({
  name: "pg prepared: unsafe() queries are prepared by default",
  ignore: skip,
  async fn() {
    const pool = createPostgresJsPool({ url: URL! });
    const client = await pool.connect();
    try {
      // Fresh session: no prepared statements yet.
      await client.queryObject("deallocate all");
      assertEquals(await preparedCount(client), 0);

      // A parameterized query on the prepared path registers a named statement.
      await client.queryObject("select $1::int as n", [7]);
      assert(
        await preparedCount(client) >= 1,
        "expected a named prepared statement after a parameterized query",
      );
    } finally {
      client.release?.();
      await pool.end?.();
    }
  },
});

Deno.test({
  name: "pg prepared: prepare:false runs unprepared (PgBouncer-safe)",
  ignore: skip,
  async fn() {
    const pool = createPostgresJsPool({ url: URL!, prepare: false });
    const client = await pool.connect();
    try {
      await client.queryObject("deallocate all");
      await client.queryObject("select $1::int as n", [7]);
      // Neither the query above nor this count is prepared → session stays empty.
      assertEquals(await preparedCount(client), 0);
    } finally {
      client.release?.();
      await pool.end?.();
    }
  },
});
