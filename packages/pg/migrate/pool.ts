// deno-lint-ignore no-import-prefix
import { Pool } from "jsr:@db/postgres@^0.19.5";

import { MigrationError } from "@sisal/migrate";

/** Result shape returned by the underlying PostgreSQL client. */
export interface PgDriverResult<Row = Record<string, unknown>> {
  readonly rows: Row[];
  readonly rowCount?: number;
}

/** Minimal PostgreSQL client surface used by the migration adapter. */
export interface PgClient {
  queryObject<Row = Record<string, unknown>>(
    query: string,
    args?: unknown[],
  ): Promise<PgDriverResult<Row>>;

  release?(): void;
  end?(): Promise<void>;
}

/** Minimal PostgreSQL pool surface used by the migration adapter. */
export interface PgPool {
  connect(): Promise<PgClient>;
  end?(): Promise<void>;
}

/** Connection options accepted by PostgreSQL migration adapter factories. */
export interface PgConnectionOptions {
  readonly url?: string;
  readonly pool?: PgPool;
  readonly client?: PgClient;
  readonly poolSize?: number;
  readonly lazy?: boolean;
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
