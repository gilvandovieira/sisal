import { OrmError } from "@sisal/orm";

import { createPostgresJsPool } from "./postgres_js_pool.ts";

/**
 * Which underlying driver an `@sisal/pg` URL connection uses.
 *
 * - `"postgres-js"` (default since v0.10) — `npm:postgres` (postgres.js),
 *   imported lazily on first connect. Sets `TCP_NODELAY` and pipelines the
 *   protocol, avoiding the `@db/postgres` extended-protocol stall (~40 ms per
 *   parameterized query; see {@link createPostgresJsPool}).
 * - `"db-postgres"` — the pure-JSR `jsr:@db/postgres` driver (the pre-v0.10
 *   default). Select it to stay npm-free.
 */
export type PgDriverKind = "db-postgres" | "postgres-js";

/** The driver a URL connection uses when `options.driver` is not set. */
export const DEFAULT_PG_DRIVER: PgDriverKind = "postgres-js";

/**
 * Resolves which {@link PgDriverKind} a URL connection will use — the
 * explicit `options.driver` when given, otherwise {@link DEFAULT_PG_DRIVER}.
 */
export function resolvePgDriverKind(
  options: Pick<PgConnectionOptions, "driver">,
): PgDriverKind {
  return options.driver ?? DEFAULT_PG_DRIVER;
}

/** A column descriptor from the driver's row description. */
export interface PgResultColumn {
  readonly name: string;
  /** PostgreSQL type OID (e.g. 701 = `float8`, 700 = `float4`). */
  readonly typeOid: number;
}

/** Result shape returned by the underlying PostgreSQL client. */
export interface PgDriverResult<Row = Record<string, unknown>> {
  readonly rows: Row[];
  readonly rowCount?: number;
  /**
   * Column type metadata, when the driver provides it (real `@db/postgres`
   * does; injected fakes may not). Used to coerce `float4`/`float8` reads — which
   * `@db/postgres` decodes to strings — back to `number`.
   */
  readonly rowDescription?: {
    readonly columns: ReadonlyArray<PgResultColumn>;
  } | null;
}

/** Minimal PostgreSQL client surface used by the ORM adapter. */
export interface PgClient {
  /** query object for this pg client. */
  queryObject<Row = Record<string, unknown>>(
    query: string,
    args?: unknown[],
  ): Promise<PgDriverResult<Row>>;
  /** Releases this pg client back to its owner. */

  /** Closes resources held by this pg client. */
  release?(): void;
  /** Closes resources held by this pg client. */
  end?(): Promise<void>;
}

/** Minimal PostgreSQL pool surface used by the ORM adapter. */
export interface PgPool {
  /** Closes resources held by this pg pool. */
  connect(): Promise<PgClient>;
  /** Closes resources held by this pg pool. */
  end?(): Promise<void>;
}

/** Connection options accepted by PostgreSQL ORM adapter factories. */
export interface PgConnectionOptions {
  /** pool for this pg connection options. */
  readonly url?: string;
  /** client for this pg connection options. */
  readonly pool?: PgPool;
  /** pool size for this pg connection options. */
  readonly client?: PgClient;
  /** lazy for this pg connection options. */
  readonly poolSize?: number;
  /** lazy for this pg connection options. */
  readonly lazy?: boolean;
  /**
   * Driver used when connecting by `url`. Defaults to `"postgres-js"`
   * (postgres.js, lazily imported — avoids the `@db/postgres`
   * parameterized-query stall). Use `"db-postgres"` for the pure-JSR
   * `@db/postgres` driver.
   */
  readonly driver?: PgDriverKind;
  /**
   * postgres.js only: use named prepared statements. Defaults to `true`; set
   * `false` for PgBouncer/Neon-pooled endpoints. Ignored by `@db/postgres`.
   */
  readonly prepare?: boolean;
  /** postgres.js only: seconds an idle pooled connection is kept. */
  readonly idleTimeout?: number;
}

/** Resolved PostgreSQL connection source with ownership metadata. */
export interface PgConnectionSource {
  readonly pool?: PgPool;
  readonly client?: PgClient;
  readonly ownsPool: boolean;
  readonly ownsClient: boolean;
}

/** Constructor shape of the `@db/postgres` `Pool`, resolved lazily. */
type DbPostgresPoolCtor = new (
  url: string,
  size: number,
  lazy: boolean,
) => PgPool;

/**
 * Throws a clear error if the `db-postgres` driver is selected on a runtime
 * without Deno's TCP API (`Deno.connect`) — the pure-JSR `@db/postgres` driver
 * is Deno-only. On Node use the default `postgres-js` driver (`npm:postgres`)
 * or inject a pool. Without this, a mis-selection surfaces as an opaque
 * module-resolution failure at import time.
 */
function assertDbPostgresRuntime(): void {
  const deno = (globalThis as { Deno?: { connect?: unknown } }).Deno;
  if (typeof deno?.connect !== "function") {
    throw new OrmError(
      'The "db-postgres" driver requires Deno; on other runtimes use the ' +
        'default "postgres-js" driver (npm:postgres) or inject a pool via ' +
        "connect({ pool }).",
      { code: "ORM_DRIVER_MISSING", status: 400 },
    );
  }
}

/**
 * Creates a PostgreSQL pool backed by the pure-JSR `@db/postgres` driver,
 * imported **lazily** on first connect (same discipline as the postgres.js
 * pool). Deferring the import keeps the `jsr:@db/postgres` specifier off the
 * module's static graph, so the module loads under runtimes that reject the
 * `jsr:` scheme; the driver is only fetched when a `db-postgres` URL source is
 * actually connected.
 */
export function createPgPool(options: {
  readonly url: string;
  readonly poolSize?: number;
  readonly lazy?: boolean;
}): PgPool {
  let opening: Promise<PgPool> | undefined;

  const open = (): Promise<PgPool> => {
    return opening ??= (async () => {
      assertDbPostgresRuntime();
      // Computed specifier: keeps this Deno-only driver off the static module
      // graph so the npm build (dnt) never pulls it into the Node bundle. The
      // guard above ensures we only reach here on Deno, where the import map
      // resolves `@db/postgres` at runtime.
      const specifier = ["@db", "postgres"].join("/");
      const mod = await import(specifier) as unknown as {
        Pool: DbPostgresPoolCtor;
      };
      return new mod.Pool(
        options.url,
        options.poolSize ?? 5,
        options.lazy ?? true,
      );
    })();
  };

  return {
    async connect(): Promise<PgClient> {
      return (await open()).connect();
    },

    async end(): Promise<void> {
      if (opening === undefined) {
        return;
      }
      await (await opening).end?.();
    },
  };
}

/** Resolves a PostgreSQL pool, client, or URL into a connection source. */
export function resolvePgConnectionSource(
  options: PgConnectionOptions,
): PgConnectionSource {
  if (options.pool !== undefined && options.client !== undefined) {
    throw new OrmError(
      "Configure either a PostgreSQL pool or client, not both",
      {
        code: "ORM_INVALID_QUERY",
        status: 400,
      },
    );
  }

  if (options.pool !== undefined) {
    return {
      pool: options.pool,
      ownsPool: false,
      ownsClient: false,
    };
  }

  if (options.client !== undefined) {
    return {
      client: options.client,
      ownsPool: false,
      ownsClient: false,
    };
  }

  if (options.url === undefined || options.url.trim().length === 0) {
    throw new OrmError("PostgreSQL connection url is required", {
      code: "ORM_DRIVER_MISSING",
      status: 400,
    });
  }

  return {
    pool: resolvePgDriverKind(options) === "db-postgres"
      ? createPgPool({
        url: options.url,
        poolSize: options.poolSize,
        lazy: options.lazy,
      })
      : createPostgresJsPool({
        url: options.url,
        poolSize: options.poolSize,
        prepare: options.prepare,
        idleTimeout: options.idleTimeout,
      }),
    ownsPool: true,
    ownsClient: false,
  };
}
