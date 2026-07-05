import { MigrationError } from "@sisal/migrate";

/** Result shape returned by the underlying PostgreSQL client. */
export interface PgDriverResult<Row = Record<string, unknown>> {
  readonly rows: Row[];
  readonly rowCount?: number;
}

/** Minimal PostgreSQL client surface used by the migration adapter. */
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

/** Minimal PostgreSQL pool surface used by the migration adapter. */
export interface PgPool {
  /** Closes resources held by this pg pool. */
  connect(): Promise<PgClient>;
  /** Closes resources held by this pg pool. */
  end?(): Promise<void>;
}

/** Connection options accepted by PostgreSQL migration adapter factories. */
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
 * Throws a clear error if the pure-JSR `@db/postgres` driver is used on a
 * runtime without Deno's TCP API (`Deno.connect`) — it is Deno-only. On Node,
 * inject a pool/client. Without this, the mis-use surfaces as an opaque
 * module-resolution failure at import time.
 */
function assertDbPostgresRuntime(): void {
  const deno = (globalThis as { Deno?: { connect?: unknown } }).Deno;
  if (typeof deno?.connect !== "function") {
    throw new MigrationError(
      "The @db/postgres driver requires Deno; on other runtimes inject a " +
        "pool or client via the migration adapter options.",
      { code: "MIGRATION_DRIVER_MISSING", status: 400 },
    );
  }
}

/**
 * Creates a PostgreSQL pool backed by the pure-JSR `@db/postgres` driver,
 * imported **lazily** on first connect. Deferring the import keeps the driver
 * off the module's static graph, so the migration adapter loads under runtimes
 * that reject the `jsr:` scheme; the driver is only fetched when a URL source is
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
      // guard above ensures we only reach here on Deno.
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
    throw new MigrationError(
      "Configure either a PostgreSQL pool or client, not both",
      {
        code: "MIGRATION_INVALID",
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
    throw new MigrationError("PostgreSQL connection url is required", {
      code: "MIGRATION_DRIVER_MISSING",
      status: 400,
    });
  }

  return {
    pool: createPgPool({
      url: options.url,
      poolSize: options.poolSize,
      lazy: options.lazy,
    }),
    ownsPool: true,
    ownsClient: false,
  };
}
