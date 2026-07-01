/**
 * MySQL driver survey benchmark (v0.6.0 workstream C, task C6).
 *
 * The v0.7 `@sisal/mysql` adapter needs a driver that works on **Deno and
 * Node** (the npm-readiness door-open constraint), authenticates against
 * MySQL 8's default `caching_sha2_password`, pools, and — the v0.5.1 lesson —
 * does not stall on parameterized round trips (`@db/postgres` lost ~40 ms per
 * query to Nagle × delayed-ACK; sequential per-query latency is therefore the
 * discriminating metric, measured exactly like `perf/pg_driver_latency.ts`).
 *
 * Candidates measured, each through its text-protocol and (where offered)
 * true-prepared path:
 *
 * - `npm:mysql2`   — the de-facto Node driver (MIT). `query()` = text
 *   protocol, `execute()` = prepared + statement cache.
 * - `npm:mariadb`  — MariaDB Connector/Node.js (LGPL-2.1). Same split.
 * - `jsr:@db/mysql@3.0.0-rc.1` — the pure-JSR Deno driver (denodrivers v3),
 *   release-candidate only (`latest: null`), Deno-only.
 * - `npm:@planetscale/database` is **survey-only**: it speaks HTTP to
 *   PlanetScale's edge, so there is nothing local to benchmark.
 *
 * All drivers are loaded through runtime-computed specifiers, so they stay
 * soft, run-time-only dependencies of this probe (the workspace packages take
 * on no MySQL driver — a v0.6 non-goal).
 *
 * A value-shape probe also prints how each driver decodes `BIGINT`,
 * `DECIMAL`, `DATETIME`, `TINYINT(1)`, and JSON from a real table — input for
 * C4's type mapping and the cross-adapter `bigint` decision.
 *
 * Run it (any MySQL or MariaDB):
 * ```sh
 * MYSQL_URL=mysql://root:root@localhost:33084/sisal deno task perf:mysql
 * ```
 *
 * @module
 */

import {
  formatResultsTable,
  type LatencyPath,
  type LatencySummary,
  measure,
  type MeasureOptions,
} from "./latency.ts";

/** Parameterized form (the metric that exposed the pg driver stall). */
const PARAM_SQL = "select ? as a, ? as b";
/** Inlined-literal control. */
const INLINE_SQL = "select 'x' as a, 1 as b";
const ARGS: unknown[] = ["x", 1];

// The decoding probe uses a real table so column types are authentic
// (`cast()` cannot produce TINYINT(1) or JSON columns).
const SHAPE_DDL = [
  "drop table if exists it_shape_probe",
  `create table it_shape_probe (
    big bigint,
    dec_col decimal(10, 2),
    dt datetime,
    tiny tinyint(1),
    js json
  )`,
  // 9007199254740993 exceeds Number.MAX_SAFE_INTEGER by 2 — a lossy decode
  // comes back as …92.
  `insert into it_shape_probe values
    (9007199254740993, 1.50, '2026-01-01 10:00:00', 1, '{"note":"n"}')`,
];
const SHAPE_SQL = "select big, dec_col, dt, tiny, js from it_shape_probe";
const SHAPE_DROP = "drop table if exists it_shape_probe";

function env(name: string): string | undefined {
  try {
    return Deno.env.get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

interface UrlParts {
  hostname: string;
  port: number;
  user: string;
  password: string;
  db: string;
}

function parseUrl(raw: string): UrlParts {
  const url = new URL(raw);
  return {
    hostname: url.hostname,
    port: url.port === "" ? 3306 : Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    db: url.pathname.replace(/^\//, ""),
  };
}

// Runtime-computed specifiers: opaque to `deno check`/static analysis, so the
// drivers are soft, run-time-only dependencies (the postgres_js_pool pattern).
function loadDriver(kind: "npm" | "jsr", name: string): Promise<unknown> {
  return import([`${kind}:`, name].join(""));
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value instanceof Date) return "Date";
  if (typeof value === "bigint") return `bigint (${value})`;
  if (typeof value === "object") return `object ${JSON.stringify(value)}`;
  return `${typeof value} (${String(value)})`;
}

function printShape(driver: string, row: Record<string, unknown>): void {
  console.log(`  value shapes — ${driver}:`);
  for (const key of ["big", "dec_col", "dt", "tiny", "js"]) {
    console.log(`    ${key.padEnd(8)} ${describeValue(row[key])}`);
  }
}

/** Sequential-latency paths + a pooled throughput run for one driver. */
interface DriverProbe {
  readonly label: string;
  readonly paths: LatencyPath[];
  /** Runs `total` prepared queries over a pool; returns elapsed ms. */
  throughput?: (total: number) => Promise<number>;
  close(): Promise<void>;
}

/** Drains up to `total` promises with a bounded in-flight window. */
async function drain(
  total: number,
  spawn: () => Promise<unknown>,
): Promise<number> {
  const start = performance.now();
  const inFlight: Promise<unknown>[] = [];
  for (let i = 0; i < total; i++) {
    inFlight.push(spawn());
    if (inFlight.length >= 64) {
      await Promise.all(inFlight.splice(0));
    }
  }
  await Promise.all(inFlight);
  return performance.now() - start;
}

interface Mysql2Like {
  createConnection(config: unknown): Promise<{
    query(sql: string, args?: unknown[]): Promise<unknown>;
    execute(sql: string, args?: unknown[]): Promise<unknown>;
    end(): Promise<void>;
  }>;
  createPool(config: unknown): {
    execute(sql: string, args?: unknown[]): Promise<unknown>;
    end(): Promise<void>;
  };
}

async function probeMysql2(parts: UrlParts): Promise<DriverProbe> {
  const mod = await loadDriver("npm", "mysql2@^3.22.5/promise") as {
    default: Mysql2Like;
  };
  const mysql = mod.default;
  const config = {
    host: parts.hostname,
    port: parts.port,
    user: parts.user,
    password: parts.password,
    database: parts.db,
  };
  const conn = await mysql.createConnection(config);
  for (const stmt of SHAPE_DDL) await conn.query(stmt);
  const shape = await conn.query(SHAPE_SQL) as Record<string, unknown>[][];
  printShape("mysql2 (defaults)", shape[0][0]);
  await conn.query(SHAPE_DROP);

  const pool = mysql.createPool({ ...config, connectionLimit: 8 });
  return {
    label: "mysql2",
    paths: [
      {
        id: "mysql2-query",
        label: "mysql2 query() text protocol",
        kind: "driver",
        fn: () => conn.query(PARAM_SQL, ARGS as unknown[]),
      },
      {
        id: "mysql2-execute",
        label: "mysql2 execute() prepared",
        kind: "driver",
        fn: () => conn.execute(PARAM_SQL, ARGS as unknown[]),
      },
      {
        id: "mysql2-inline",
        label: "mysql2 query() inline literals",
        kind: "control",
        fn: () => conn.query(INLINE_SQL),
      },
    ],
    throughput: (total) =>
      drain(total, () => pool.execute(PARAM_SQL, ARGS as unknown[])),
    close: async () => {
      await conn.end();
      await pool.end();
    },
  };
}

interface MariadbLike {
  createConnection(config: unknown): Promise<{
    query(sql: string, args?: unknown[]): Promise<unknown>;
    execute(sql: string, args?: unknown[]): Promise<unknown>;
    end(): Promise<void>;
  }>;
  createPool(config: unknown): {
    execute(sql: string, args?: unknown[]): Promise<unknown>;
    end(): Promise<void>;
  };
}

async function probeMariadb(parts: UrlParts): Promise<DriverProbe> {
  const mod = await loadDriver("npm", "mariadb@^3.5.3") as {
    default: MariadbLike;
  };
  const mariadb = mod.default;
  const config = {
    host: parts.hostname,
    port: parts.port,
    user: parts.user,
    password: parts.password,
    database: parts.db,
  };
  const conn = await mariadb.createConnection(config);
  for (const stmt of SHAPE_DDL) await conn.query(stmt);
  const shapeRows = await conn.query(SHAPE_SQL) as Record<string, unknown>[];
  printShape("mariadb (defaults)", shapeRows[0]);
  await conn.query(SHAPE_DROP);

  const pool = mariadb.createPool({ ...config, connectionLimit: 8 });
  return {
    label: "mariadb",
    paths: [
      {
        id: "mariadb-query",
        label: "mariadb query() text protocol",
        kind: "driver",
        fn: () => conn.query(PARAM_SQL, ARGS as unknown[]),
      },
      {
        id: "mariadb-execute",
        label: "mariadb execute() prepared",
        kind: "driver",
        fn: () => conn.execute(PARAM_SQL, ARGS as unknown[]),
      },
      {
        id: "mariadb-inline",
        label: "mariadb query() inline literals",
        kind: "control",
        fn: () => conn.query(INLINE_SQL),
      },
    ],
    throughput: (total) =>
      drain(total, () => pool.execute(PARAM_SQL, ARGS as unknown[])),
    close: async () => {
      await conn.end();
      await pool.end();
    },
  };
}

interface MysqlClientLike {
  connect(): Promise<void>;
  query(sql: string, args?: unknown[]): Promise<unknown>;
  execute(sql: string, args?: unknown[]): Promise<unknown>;
  close(): Promise<void>;
}

async function probeDenoMysql(url: string): Promise<DriverProbe> {
  const mod = await loadDriver("jsr", "@db/mysql@3.0.0-rc.1") as {
    MysqlClient: new (url: string) => MysqlClientLike;
  };
  const client = new mod.MysqlClient(url);
  await client.connect();
  for (const stmt of SHAPE_DDL) await client.execute(stmt);
  const shape = await client.query(SHAPE_SQL) as Record<string, unknown>[];
  printShape("@db/mysql (defaults)", shape[0]);
  await client.execute(SHAPE_DROP);

  return {
    label: "@db/mysql",
    paths: [
      {
        id: "denomysql-query",
        label: "@db/mysql query() with params",
        kind: "driver",
        fn: () => client.query(PARAM_SQL, ARGS as unknown[]),
      },
      {
        id: "denomysql-inline",
        label: "@db/mysql query() inline literals",
        kind: "control",
        fn: () => client.query(INLINE_SQL),
      },
    ],
    close: () => client.close(),
  };
}

async function main(): Promise<void> {
  const url = env("MYSQL_URL");
  if (url === undefined) {
    console.error(
      "MYSQL_URL is required, e.g. " +
        "MYSQL_URL=mysql://root:root@localhost:33084/sisal",
    );
    Deno.exit(2);
  }
  const parts = parseUrl(url);
  const serverLabel = env("MYSQL_SERVER_LABEL") ?? "mysql";
  const options: MeasureOptions = { iters: 300, warmup: 30 };
  const THROUGHPUT_TOTAL = 2000;

  console.log(
    `MySQL driver survey — server=${serverLabel} ` +
      `(${parts.hostname}:${parts.port}), sequential iters=${options.iters}\n`,
  );

  const results: LatencySummary[] = [];
  const throughputLines: string[] = [];

  const probes: Array<[string, () => Promise<DriverProbe>]> = [
    ["mysql2", () => probeMysql2(parts)],
    ["mariadb", () => probeMariadb(parts)],
    ["@db/mysql", () => probeDenoMysql(url)],
  ];

  for (const [name, factory] of probes) {
    let probe: DriverProbe;
    try {
      probe = await factory();
    } catch (error) {
      console.log(
        `  ${name}: FAILED to connect — ${(error as Error).message}\n`,
      );
      continue;
    }
    for (const path of probe.paths) {
      results.push(await measure(path, options));
    }
    if (probe.throughput !== undefined) {
      const elapsed = await probe.throughput(THROUGHPUT_TOTAL);
      throughputLines.push(
        `  ${probe.label.padEnd(10)} pool=8 ` +
          `${THROUGHPUT_TOTAL} prepared queries in ${elapsed.toFixed(0)} ms ` +
          `→ ${(THROUGHPUT_TOTAL / (elapsed / 1000)).toFixed(0)} qps`,
      );
    }
    await probe.close();
    console.log();
  }

  console.log(formatResultsTable(results));
  if (throughputLines.length > 0) {
    console.log("\npooled throughput:");
    for (const line of throughputLines) console.log(line);
  }
}

if (import.meta.main) {
  await main();
}
