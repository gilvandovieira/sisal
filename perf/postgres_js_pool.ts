/**
 * A postgres.js-backed `PgPool` adapter for the perf probe.
 *
 * This mirrors the validated fix from
 * [`PG_ADAPTER_PERF_REPORT.md`](./PG_ADAPTER_PERF_REPORT.md) §4①: `@sisal/pg`'s
 * executor is driver-agnostic — it acquires a `PgClient` from a `PgPool` per
 * `execute()` and releases it — so a pool implemented over `npm:postgres`
 * (postgres.js, which sets `TCP_NODELAY` and pipelines the extended protocol)
 * drops per-query latency ~100× **with no change to `@sisal/orm` or the
 * executor**. Injected via the public `connect({ pool })` API.
 *
 * This lives in `perf/` (not a shipped package) purely so the benchmark can
 * measure Sisal-over-postgres.js as a first-class path. Productionizing it — a
 * default driver swap or a `@sisal/pg-js` sibling — is separate, larger work.
 *
 * postgres.js is loaded lazily behind a runtime-computed specifier so
 * `deno check` never requires the npm module, and `perf:pg` runs with
 * `--no-lock` so resolving it does not rewrite the workspace lockfile.
 *
 * @module
 */

import type { PgClient, PgPool } from "@sisal/pg";

/** Structural view of one column descriptor in a postgres.js result. */
interface PostgresJsColumn {
  readonly name: string;
  /** PostgreSQL type OID — postgres.js exposes it as `type`. */
  readonly type: number;
}

/** Structural view of a postgres.js query result (an array of rows + meta). */
interface PostgresJsResult extends ArrayLike<Record<string, unknown>> {
  readonly count?: number;
  readonly columns?: ReadonlyArray<PostgresJsColumn>;
}

/** A reserved (pinned) postgres.js connection. */
interface ReservedSql {
  unsafe(query: string, args?: readonly unknown[]): Promise<PostgresJsResult>;
  release(): void;
}

/** The subset of the postgres.js `Sql` handle this adapter uses. */
export interface PostgresJsSql {
  unsafe(query: string, args?: readonly unknown[]): Promise<unknown>;
  reserve(): Promise<ReservedSql>;
  end(): Promise<void>;
}

type PostgresJsFactory = (
  url: string,
  options?: Record<string, unknown>,
) => PostgresJsSql;

let factoryPromise: Promise<PostgresJsFactory | undefined> | undefined;

function loadFactory(): Promise<PostgresJsFactory | undefined> {
  // Runtime-computed specifier: opaque to `deno check`/static analysis, so the
  // npm module is a soft, run-time-only dependency.
  return factoryPromise ??= (async () => {
    try {
      const specifier = ["npm:", "postgres@^3.4.7"].join("");
      const mod = await import(specifier) as { default?: PostgresJsFactory };
      return mod.default ?? (mod as unknown as PostgresJsFactory);
    } catch (error) {
      console.warn(
        `  (postgres.js unavailable: ${(error as Error).message})`,
      );
      return undefined;
    }
  })();
}

/**
 * Open a postgres.js `Sql` handle, or `undefined` if the npm module can't be
 * loaded (offline / not cached). `prepare: false` keeps `unsafe` on the simple
 * extended-protocol path used by the benchmark.
 */
export async function createPostgresJs(
  url: string,
  options: Record<string, unknown> = {},
): Promise<PostgresJsSql | undefined> {
  const factory = await loadFactory();
  return factory?.(url, { prepare: false, ...options });
}

/**
 * Wrap a postgres.js `Sql` handle as a Sisal {@link PgPool}. Each
 * `connect()` reserves a connection; `release()` returns it — the exact
 * lifecycle `@sisal/pg`'s executor drives per `execute()`.
 */
export function postgresJsPoolFrom(sql: PostgresJsSql): PgPool {
  return {
    async connect(): Promise<PgClient> {
      const reserved = await sql.reserve();
      return {
        async queryObject<Row = Record<string, unknown>>(
          query: string,
          args: unknown[] = [],
        ) {
          const result = await reserved.unsafe(query, args);
          const rows = Array.from(result) as Row[];
          const columns = (result.columns ?? []).map((column) => ({
            name: column.name,
            typeOid: column.type,
          }));
          return {
            rows,
            rowCount: result.count ?? rows.length,
            rowDescription: { columns },
          };
        },
        release() {
          reserved.release();
        },
      };
    },
    async end() {
      await sql.end();
    },
  };
}
