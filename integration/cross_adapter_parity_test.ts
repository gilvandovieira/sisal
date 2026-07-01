/**
 * Cross-adapter decode-parity suite.
 *
 * Runs the *same* schema-free rich query through every PostgreSQL-family adapter
 * and asserts how their decoded rows relate:
 *
 * - The two `@sisal/pg` drivers — pure-JSR `@db/postgres` and `npm:postgres`
 *   (`driver: "postgres-js"`, added in 0.5.1) — must decode **byte-identically**,
 *   so they are drop-in interchangeable.
 * - `@sisal/neon` (via `@neon/serverless`) must align with `@sisal/pg` on every
 *   type **except the documented divergences**, which are pinned here so a
 *   driver behavior change fails this test and forces a doc update (the same
 *   discipline as `docs/drizzle-parity.md`).
 *
 * Because the adapters share `POSTGRES_DIALECT` and `@sisal/pg`'s builder, SQL
 * rendering is identical by construction; the only thing that can differ is how
 * each underlying driver decodes result values, which is exactly what this pins.
 *
 * Gating (skipped otherwise, like the other `integration/` suites):
 * ```sh
 * # pg-driver parity (both @sisal/pg drivers vs one Postgres):
 * DATABASE_URL=postgres://postgres:postgres@localhost:55416/sisal \
 *   deno test --allow-net --allow-env --allow-read --allow-ffi \
 *   integration/cross_adapter_parity_test.ts
 *
 * # + neon parity (needs the wsproxy backend up):
 * DATABASE_URL=postgres://postgres:postgres@localhost:55416/sisal \
 *   NEON_DATABASE_URL=postgres://postgres:postgres@localhost/sisal \
 *   NEON_WS_PROXY=localhost:5499 \
 *   deno test --allow-net --allow-env --allow-read --allow-ffi \
 *   integration/cross_adapter_parity_test.ts
 * ```
 *
 * @module
 */

import { assert, assertEquals } from "@std/assert";
import { raw } from "@sisal/orm";
import { connect as connectPg, type PgDatabase } from "@sisal/pg";
import { connect as connectNeon, type NeonDatabase } from "@sisal/neon";

import { env } from "./_shared/env.ts";
import { configureNeonWebSocketProxy } from "./_shared/neon.ts";

const PG_URL = env("DATABASE_URL");
const NEON_URL = env("NEON_DATABASE_URL");
const NEON_WS_PROXY = env("NEON_WS_PROXY");

const SKIP_PG = PG_URL === undefined;
const SKIP_NEON = SKIP_PG || NEON_URL === undefined ||
  NEON_WS_PROXY === undefined;

// One row that exercises every decode path — no schema, so it runs anywhere.
const RICH = raw(`select
  42::int as i,
  'hi'::text as t,
  true::bool as b,
  9007199254740993::bigint as big,
  1234.50::numeric(12,2) as num,
  98.6::float8 as f,
  '{a,b}'::text[] as arr,
  '{"k":1}'::jsonb as j,
  '2026-06-28'::date as d,
  '12:34:56'::time as tm,
  '2026-06-28 12:34:56.123'::timestamp as ts,
  '2026-06-28 12:34:56.123+00'::timestamptz as tstz,
  null::int as n`);

/** Canonical `kind:value` string for a decoded field, for cross-driver diffing. */
function cell(value: unknown): string {
  const kind = value === null
    ? "null"
    : value instanceof Date
    ? "Date"
    : Array.isArray(value)
    ? "array"
    : typeof value;
  const shown = value instanceof Date
    ? value.toISOString()
    : typeof value === "object" && value !== null
    ? JSON.stringify(value)
    : String(value);
  return `${kind}:${shown}`;
}

type Row = Record<string, unknown>;

async function readRich(
  db: PgDatabase | NeonDatabase,
): Promise<Row> {
  const result = await db.execute<Row>(RICH);
  return result.rows[0];
}

function printParity(label: string, a: Row, b: Row): void {
  const line = Object.keys(a).map((k) =>
    `${k}=${cell(a[k]) === cell(b[k]) ? "=" : "≠"}`
  ).join(" ");
  console.log(`  ${label}: ${line}`);
}

Deno.test({
  name:
    "parity: @sisal/pg @db/postgres and postgres.js decode byte-identically",
  ignore: SKIP_PG,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const dbPg = await connectPg({ url: PG_URL! });
    const dbJs = await connectPg({ url: PG_URL!, driver: "postgres-js" });
    try {
      const rowPg = await readRich(dbPg);
      const rowJs = await readRich(dbJs);
      printParity("@db/postgres vs postgres.js", rowPg, rowJs);

      for (const key of Object.keys(rowPg)) {
        assertEquals(
          cell(rowJs[key]),
          cell(rowPg[key]),
          `column "${key}": postgres.js decoded ${cell(rowJs[key])} but ` +
            `@db/postgres decoded ${cell(rowPg[key])} — the drivers must match`,
        );
      }
    } finally {
      await dbPg.close();
      await dbJs.close();
    }
  },
});

Deno.test({
  name:
    "parity: @sisal/neon aligns with @sisal/pg except documented divergences",
  ignore: SKIP_NEON,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await configureNeonWebSocketProxy(NEON_WS_PROXY);
    const pg = await connectPg({ url: PG_URL! });
    const neon = await connectNeon({ url: NEON_URL! });
    try {
      const rowPg = await readRich(pg);
      const rowNeon = await readRich(neon);
      printParity("neon vs pg", rowNeon, rowPg);

      // Columns that must decode identically across neon and pg. `big` and `d`
      // are handled below: `big` is a real divergence; `d` (raw `date` → `Date`)
      // differs only in its midnight timezone convention (neon local vs pg UTC),
      // which is process-TZ-dependent and resolves under `temporal:{parse:true}`,
      // so it is not asserted for raw equality here.
      const identical = Object.keys(rowPg).filter((k) =>
        k !== "big" && k !== "d"
      );
      for (const key of identical) {
        assertEquals(
          cell(rowNeon[key]),
          cell(rowPg[key]),
          `column "${key}": neon decoded ${
            cell(rowNeon[key])
          } but pg decoded ` +
            `${cell(rowPg[key])} — a new, undocumented divergence`,
        );
      }

      // Documented divergence: bigint. Pinned so it fails if either side drifts.
      // (`@sisal/pg` returns int8 as `BigInt`; `@sisal/neon` returns it as a
      // string. See docs/v0.6.0-roadmap.md "Cross-adapter parity".)
      assertEquals(
        typeof rowPg.big,
        "bigint",
        `@sisal/pg should decode bigint as BigInt, got ${cell(rowPg.big)}`,
      );
      assertEquals(
        typeof rowNeon.big,
        "string",
        `@sisal/neon should decode bigint as string, got ${cell(rowNeon.big)}`,
      );
      assert(
        String(rowPg.big) === String(rowNeon.big),
        "bigint values must be numerically equal across adapters even though " +
          "their JS types differ",
      );
    } finally {
      await pg.close();
      await neon.close();
    }
  },
});
