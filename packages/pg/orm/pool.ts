// deno-lint-ignore no-import-prefix
import { Pool } from "jsr:@db/postgres@^0.19.5";

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
  queryObject<Row = Record<string, unknown>>(
    query: string,
    args?: unknown[],
  ): Promise<PgDriverResult<Row>>;

  release?(): void;
  end?(): Promise<void>;
}

/** Minimal PostgreSQL pool surface used by the ORM adapter. */
export interface PgPool {
  connect(): Promise<PgClient>;
  end?(): Promise<void>;
}

/** Connection options accepted by PostgreSQL ORM adapter factories. */
export interface PgConnectionOptions {
  readonly url?: string;
  readonly pool?: PgPool;
  readonly client?: PgClient;
  readonly poolSize?: number;
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

/** Creates a PostgreSQL pool using the bundled `@db/postgres` driver. */
export function createPgPool(options: {
  readonly url: string;
  readonly poolSize?: number;
  readonly lazy?: boolean;
}): PgPool {
  return new Pool(options.url, options.poolSize ?? 5, options.lazy ?? true);
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
