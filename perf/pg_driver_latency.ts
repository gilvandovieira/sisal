/**
 * Real-Postgres latency probe that isolates Sisal's per-query cost from the
 * cost of the underlying driver — and measures the validated fix.
 *
 * Background: swapping an app onto `@sisal/pg` regressed a feed endpoint from
 * thousands of rps to ~120 rps. The cause is **not** Sisal — it is the
 * `jsr:@db/postgres` extended-protocol path, which writes Parse/Bind/Describe/
 * Execute/Sync as separate un-coalesced TCP segments on a socket without
 * `TCP_NODELAY`, tripping the classic Nagle × delayed-ACK deadlock (~40 ms per
 * parameterized round-trip). See `perf/PG_ADAPTER_PERF_REPORT.md`.
 *
 * This probe measures the same query six ways so the cost is attributable:
 *
 * - `sisal-render`  — build + render the query, no database (builder overhead).
 * - `sisal-execute` — `@sisal/pg` `db.execute(...)` over `@db/postgres` (default).
 * - `driver-param`  — raw `@db/postgres` parameterized (`{ text, args }`).
 * - `driver-inline` — raw `@db/postgres` inlined literals (simple protocol).
 * - `pgjs-param`    — `postgres.js` parameterized (fast reference), if present.
 * - `sisal-pgjs`    — `@sisal/pg` `db.execute(...)` over a postgres.js pool (the
 *   validated fix, injected via `connect({ pool })`), if present.
 *
 * The invariants this establishes: `sisal-render` is ~free, `sisal-execute`
 * tracks `driver-param` (Sisal adds nothing over whatever driver it is wired
 * to), `driver-param ≫ driver-inline` is the driver stall, and `sisal-pgjs`
 * collapses to `pgjs-param` — the fix, through Sisal's real executor, adds
 * nothing over postgres.js itself.
 *
 * The query (`select $1::text, $2::int`) needs no schema, so this runs against
 * any Postgres.
 *
 * Run it:
 * ```sh
 * DATABASE_URL=postgres://postgres:postgres@localhost:55416/sisal deno task perf:pg
 * ```
 *
 * @module
 */

import { renderSql, sql } from "@sisal/orm";
import { connect, type PgDatabase } from "@sisal/pg";
import { Client } from "@db/postgres";

import {
  formatResultsTable,
  type LatencyPath,
  type LatencySummary,
  measure,
  type MeasureOptions,
} from "./latency.ts";
import { createPostgresJs, postgresJsPoolFrom } from "./postgres_js_pool.ts";

/** Parameterized form sent through the raw driver and postgres.js. */
const PARAM_SQL = "select $1::text as a, $2::int as b";
/** Inlined-literal form (simple protocol) — the control for the stall. */
const INLINE_SQL = "select 'x'::text as a, 1::int as b";
const ARGS: unknown[] = ["x", 1];

/** Build the Sisal query fresh each call so builder cost is counted honestly. */
const sisalQuery = () => sql`select ${"x"}::text as a, ${1}::int as b`;

/** Options for {@link runPgLatencyBenchmark}. */
export interface PgLatencyOptions extends MeasureOptions {
  /** Include the `postgres.js` reference and `sisal-pgjs` paths. Default `true`. */
  readonly includePostgresJs?: boolean;
}

/** Result of a full latency run. */
export interface PgLatencyRun {
  readonly results: LatencySummary[];
  readonly includedPostgresJs: boolean;
}

/**
 * Open every measured path, time each sequentially, and tear the connections
 * down. Paths are measured in series so no two share the wire at once.
 */
export async function runPgLatencyBenchmark(
  url: string,
  options: PgLatencyOptions = {},
): Promise<PgLatencyRun> {
  const includePostgresJs = options.includePostgresJs ?? true;
  const measureOptions: MeasureOptions = {
    iters: options.iters,
    warmup: options.warmup,
  };

  const db = await connect({ url });
  const client = new Client(url);
  await client.connect();

  // One shared postgres.js handle drives both the raw reference and the Sisal
  // pool path; the paths run in series, never concurrently.
  const pgjs = includePostgresJs
    ? await createPostgresJs(url, { max: 5 })
    : undefined;
  const pgjsDb: PgDatabase | undefined = pgjs
    ? await connect({ pool: postgresJsPoolFrom(pgjs) })
    : undefined;

  const paths: LatencyPath[] = [
    {
      id: "sisal-render",
      label: "sisal render (no db)",
      kind: "sisal",
      fn: () =>
        Promise.resolve(renderSql(sisalQuery(), { dialect: "postgres" })),
    },
    {
      id: "sisal-execute",
      label: "sisal execute → @db/postgres",
      kind: "sisal",
      fn: () => db.execute(sisalQuery()),
    },
    {
      id: "driver-param",
      label: "@db/postgres parameterized",
      kind: "driver",
      fn: () => client.queryObject({ text: PARAM_SQL, args: ARGS }),
    },
    {
      id: "driver-inline",
      label: "@db/postgres inlined (simple)",
      kind: "driver",
      fn: () => client.queryObject(INLINE_SQL),
    },
  ];

  if (pgjs) {
    paths.push({
      id: "pgjs-param",
      label: "postgres.js parameterized",
      kind: "reference",
      fn: () => pgjs.unsafe(PARAM_SQL, ARGS),
    });
  }
  if (pgjsDb) {
    paths.push({
      id: "sisal-pgjs",
      label: "sisal execute → postgres.js (fix)",
      kind: "sisal",
      fn: () => pgjsDb.execute(sisalQuery()),
    });
  }

  try {
    const results: LatencySummary[] = [];
    for (const path of paths) {
      results.push(await measure(path, measureOptions));
    }
    return { results, includedPostgresJs: pgjs !== undefined };
  } finally {
    await db.close();
    await client.end();
    // `pgjsDb` was given an injected pool (it does not own it); close the shared
    // postgres.js handle explicitly.
    await pgjsDb?.close();
    await pgjs?.end();
  }
}

function findById(
  results: readonly LatencySummary[],
  id: string,
): LatencySummary | undefined {
  return results.find((r) => r.id === id);
}

function ratio(numerator: number, denominator: number): string {
  const value = numerator / Math.max(denominator, 1e-6);
  return `${value.toFixed(value >= 10 ? 0 : 1)}×`;
}

/** Print the table plus a plain-language verdict about where the time goes. */
export function reportPgLatency(run: PgLatencyRun): void {
  console.log(formatResultsTable(run.results));
  console.log();

  const render = findById(run.results, "sisal-render");
  const sisal = findById(run.results, "sisal-execute");
  const driver = findById(run.results, "driver-param");
  const inline = findById(run.results, "driver-inline");
  const pgjs = findById(run.results, "pgjs-param");
  const sisalPgjs = findById(run.results, "sisal-pgjs");

  if (render) {
    console.log(`builder:  sisal render p50 ${render.p50.toFixed(3)} ms`);
  }
  if (sisal && driver) {
    const overhead = sisal.p50 - driver.p50;
    console.log(
      `overhead: sisal execute p50 ${sisal.p50.toFixed(2)} ms vs raw driver ` +
        `${driver.p50.toFixed(2)} ms → ${overhead >= 0 ? "+" : ""}` +
        `${overhead.toFixed(2)} ms of Sisal`,
    );
  }
  if (driver && inline) {
    const stalled = driver.p50 > 5 &&
      driver.p50 / Math.max(inline.p50, 1e-6) > 4;
    console.log(
      `driver:   parameterized ${
        driver.p50.toFixed(2)
      } ms vs simple-protocol ` +
        `${inline.p50.toFixed(2)} ms → ${ratio(driver.p50, inline.p50)}`,
    );
    if (stalled) {
      console.log(
        "          ⚠ extended-protocol stall present in @db/postgres " +
          "(Nagle × delayed-ACK). Not a Sisal cost — see " +
          "perf/PG_ADAPTER_PERF_REPORT.md.",
      );
    }
  }
  if (sisalPgjs && sisal) {
    console.log(
      `FIX:      sisal over postgres.js p50 ${sisalPgjs.p50.toFixed(2)} ms → ` +
        `${
          ratio(sisal.p50, sisalPgjs.p50)
        } faster than sisal over @db/postgres`,
    );
    if (pgjs) {
      const overhead = sisalPgjs.p50 - pgjs.p50;
      console.log(
        `          (+${overhead.toFixed(2)} ms over raw postgres.js — Sisal ` +
          "stays thin over the fast driver too)",
      );
    }
  }
}

function envInt(name: string): number | undefined {
  const raw = Deno.env.get(name);
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function main(): Promise<void> {
  const url = Deno.env.get("DATABASE_URL");
  if (!url) {
    console.error(
      "DATABASE_URL is required, e.g.\n" +
        "  DATABASE_URL=postgres://postgres:postgres@localhost:55416/sisal \\\n" +
        "    deno task perf:pg",
    );
    Deno.exit(1);
  }

  const iters = envInt("SISAL_PERF_ITERS") ?? 200;
  const warmup = envInt("SISAL_PERF_WARMUP") ?? 25;
  console.log(
    `@sisal/pg driver latency — ${iters} iters, ${warmup} warm-up, ` +
      "same query, sequential\n",
  );

  const run = await runPgLatencyBenchmark(url, { iters, warmup });
  reportPgLatency(run);
}

if (import.meta.main) {
  await main();
}
