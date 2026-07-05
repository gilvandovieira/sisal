/**
 * postgres.js-backed connection pool for `@sisal/pg`.
 *
 * The `jsr:@db/postgres` driver stalls ~40 ms per parameterized query on its
 * extended-protocol path (no `TCP_NODELAY` + un-coalesced writes → Nagle ×
 * delayed-ACK). This pool implements the same {@link PgPool}/{@link PgClient}
 * contract over `npm:postgres` (postgres.js), which sets `TCP_NODELAY` and
 * pipelines the protocol — dropping per-query latency ~100× with **no change to
 * `@sisal/orm` or the executor**. **The default URL driver since v0.10**
 * (CF1); select the pure-JSR `@db/postgres` instead with
 * `connect({ url, driver: "db-postgres" })`, or inject any pool through
 * `connect({ pool })`.
 *
 * postgres.js is imported lazily (like `@sisal/libsql`'s `@libsql/client`), so
 * it is only loaded on the first actual connect; choosing `"db-postgres"`
 * keeps the process npm-free.
 *
 * @module
 */

import type { PgClient, PgPool } from "./pool.ts";

/** A column descriptor from a postgres.js result (`type` is the PG type OID). */
interface PostgresJsColumn {
  readonly name: string;
  readonly type: number;
}

/** The array-of-rows result postgres.js returns, plus the metadata we read. */
interface PostgresJsResult extends ArrayLike<Record<string, unknown>> {
  readonly count?: number;
  readonly columns?: ReadonlyArray<PostgresJsColumn>;
}

/** Per-query options passed to postgres.js `unsafe()`. */
interface PostgresJsQueryOptions {
  /** Run as a named prepared statement (parse+plan once, then reuse). */
  readonly prepare?: boolean;
}

/** A reserved (pinned) postgres.js connection. */
interface PostgresJsReserved {
  unsafe(
    query: string,
    args?: readonly unknown[],
    options?: PostgresJsQueryOptions,
  ): Promise<PostgresJsResult>;
  release(): void;
}

/** The subset of the postgres.js `Sql` handle this pool uses. */
interface PostgresJsSql {
  reserve(): Promise<PostgresJsReserved>;
  end(options?: { readonly timeout?: number }): Promise<void>;
}

type PostgresJsFactory = (
  url: string,
  options?: Record<string, unknown>,
) => PostgresJsSql;

/** Options for {@link createPostgresJsPool}. */
export interface PostgresJsPoolOptions {
  /** PostgreSQL connection URL. */
  readonly url: string;
  /** Max pooled connections (postgres.js `max`). Defaults to `5`. */
  readonly poolSize?: number;
  /**
   * Whether to use named prepared statements. Defaults to `true`. Set `false`
   * for PgBouncer/Neon-pooled endpoints (transaction pooling rejects named
   * prepared statements); harmless on a direct connection.
   */
  readonly prepare?: boolean;
  /** Seconds a pooled connection may sit idle before it is closed. */
  readonly idleTimeout?: number;
}

async function openSql(options: PostgresJsPoolOptions): Promise<PostgresJsSql> {
  // deno-lint-ignore no-import-prefix
  const mod = await import("npm:postgres@^3.4.7") as unknown as {
    default: PostgresJsFactory;
  };

  return mod.default(options.url, {
    max: options.poolSize ?? 5,
    prepare: options.prepare ?? true,
    // Match `@db/postgres`'s decoders so rows are byte-identical across drivers
    // (`@sisal/orm`'s temporal layer decodes from there). `@db/postgres` returns
    // int8 as `BigInt`, and builds `date`/`timestamp` (no tz) `Date`s with a
    // plain `new Date(str)` (local) — postgres.js otherwise returns bigints as
    // strings and double-shifts naive timestamps. `timestamptz`/`time` already
    // agree, so they are left on postgres.js's defaults. Sisal binds temporal
    // params as strings, so `serialize` here is never exercised.
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (value: bigint) => value.toString(),
        parse: (value: string) => BigInt(value),
      },
      date: {
        to: 1082,
        from: [1082],
        serialize: (value: string) => value,
        parse: (value: string) => new Date(value),
      },
      timestamp: {
        to: 1114,
        from: [1114],
        serialize: (value: string) => value,
        parse: (value: string) => new Date(value),
      },
    },
    ...(options.idleTimeout === undefined
      ? {}
      : { idle_timeout: options.idleTimeout }),
  });
}

/**
 * Creates a {@link PgPool} backed by postgres.js (`npm:postgres`), imported
 * lazily on first connect. Each `connect()` reserves one physical connection
 * (`sql.reserve()`) so an interactive transaction's `begin…commit` stay pinned
 * to the same socket — the lifecycle `@sisal/pg`'s executor drives per
 * `execute()`/`transaction()`.
 */
export function createPostgresJsPool(
  options: PostgresJsPoolOptions,
  // Test/advanced seam: a pre-built postgres.js handle, injected to skip the
  // lazy `npm:postgres` import. Production callers omit it and go through
  // `connect({ pool })` for pool injection; unit tests pass a fake handle.
  injectedSql?: PostgresJsSql,
): PgPool {
  let sqlPromise: Promise<PostgresJsSql> | undefined;
  const getSql =
    () => (sqlPromise ??= injectedSql
      ? Promise.resolve(injectedSql)
      : openSql(options));

  // Prepare Sisal's `unsafe(text, params)` queries by default so Postgres
  // parses+plans each query shape once and reuses it — Sisal renders stable
  // parameterized text ($1,$2,…), so the prepared cache hits. Without this,
  // every query re-parses server-side (~35µs each; see
  // perf/ORM_EXECUTE_PROFILE.md). Mirrors the pool's tagged-template `prepare`
  // default and honors `prepare: false` for PgBouncer/Neon transaction pooling.
  const prepare = options.prepare ?? true;

  return {
    async connect(): Promise<PgClient> {
      const reserved = await (await getSql()).reserve();

      return {
        async queryObject<Row = Record<string, unknown>>(
          query: string,
          args: unknown[] = [],
        ) {
          const result = await reserved.unsafe(query, args, { prepare });
          const columns = result.columns;
          return {
            rows: Array.from(result) as Row[],
            rowCount: result.count ?? result.length,
            rowDescription: columns
              ? {
                columns: columns.map((column) => ({
                  name: column.name,
                  typeOid: column.type,
                })),
              }
              : null,
          };
        },
        release() {
          reserved.release();
        },
      };
    },

    async end() {
      if (sqlPromise) {
        await (await sqlPromise).end({ timeout: 5 });
      }
    },
  };
}
