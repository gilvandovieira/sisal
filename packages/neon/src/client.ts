/** Shared structural Neon serverless client contracts and lazy client opening. */

import type {
  ClientConfig,
  PoolConfig,
  QueryResult,
  QueryResultRow,
} from "@neon/serverless";
import { SisalError } from "@sisal/orm";

/** Neon serverless single-client configuration (the driver's `ClientConfig`). */
export type NeonClientConfig = ClientConfig;
/** Neon serverless connection-pool configuration (the driver's `PoolConfig`). */
export type NeonPoolConfig = PoolConfig;
/** One raw result row as returned by the Neon driver. */
export type NeonQueryResultRow = QueryResultRow;
/** A raw Neon driver query result; rows typed as {@link NeonQueryResultRow}. */
export type NeonDriverQueryResult<
  Row extends QueryResultRow = QueryResultRow,
> = QueryResult<Row>;

/** Error codes emitted by the Neon compatibility package. */
export type NeonErrorCode =
  | "NEON_INVALID"
  | "NEON_DRIVER_MISSING"
  | "NEON_CONNECTION_FAILED"
  | "NEON_EXECUTE_FAILED";

/**
 * Structured error thrown by Neon compatibility helpers. Extends
 * {@link SisalError} so it inherits credential redaction of the message,
 * preserved `cause`, and `details` — no separate redaction path to drift
 * (SEC-011).
 */
export class NeonError extends SisalError {
  /** Stable Neon compatibility error code. */
  declare readonly code: NeonErrorCode;

  /** Creates a Neon compatibility error with optional details and cause. */
  constructor(
    message: string,
    options: {
      readonly code: NeonErrorCode;
      readonly details?: Record<string, unknown>;
      readonly cause?: unknown;
    },
  ) {
    super(message, {
      code: options.code,
      ...(options.details === undefined ? {} : { details: options.details }),
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = "NeonError";
  }
}

/** Result shape returned by Neon query-capable handles. */
export interface NeonQueryResult<Row = Record<string, unknown>> {
  /** Row count reported by this neon query result. */
  readonly rows: Row[];
  /** Row count reported by this neon query result. */
  readonly rowCount?: number | null;
}

/** Minimal Neon query surface used by the adapter. */
export interface NeonQueryable {
  /** Runs a query through this neon queryable. */
  query<Row = Record<string, unknown>>(
    query: string,
    args?: unknown[],
  ): Promise<NeonQueryResult<Row>>;
}

/** Minimal Neon client surface used by transactions. */
export interface NeonClient extends NeonQueryable {
  /** Closes resources held by this neon client. */
  release?(): void;
  /** Closes resources held by this neon client. */
  end?(): Promise<void>;
}

/** Minimal Neon pool surface used by the adapter. */
export interface NeonPool extends NeonQueryable {
  /** Closes resources held by this neon pool. */
  connect(): Promise<NeonClient>;
  /** Closes resources held by this neon pool. */
  end?(): Promise<void>;
}

/** Connection options forwarded to Neon `Pool`, with `url` as an alias. */
export interface NeonPoolConnectionOptions extends NeonPoolConfig {
  /** Connection URL used by this neon pool connection options. */
  readonly url?: string;
}

/** Connection options forwarded to Neon `Client`, with `url` as an alias. */
export interface NeonClientConnectionOptions extends NeonClientConfig {
  /** Connection URL used by this neon client connection options. */
  readonly url?: string;
}

/**
 * Loads the Neon serverless driver for the current runtime, imported lazily
 * through a **computed** specifier so the npm build (dnt) never hard-links it.
 * Deno resolves the JSR driver (`@neon/serverless`) via the workspace import
 * map; Node — which rejects that alias's scheme — resolves the npm build of the
 * same driver (`@neondatabase/serverless`) from the optional peer dependency.
 */
async function loadNeonDriver(): Promise<{
  Pool: new (config: unknown) => unknown;
  Client: new (config: unknown) => unknown;
}> {
  const deno = (globalThis as { Deno?: unknown }).Deno;
  const specifier = deno === undefined
    ? "@neondatabase/serverless"
    : "@neon/serverless";
  return await import(specifier) as unknown as {
    Pool: new (config: unknown) => unknown;
    Client: new (config: unknown) => unknown;
  };
}

/** Creates a Neon `Pool` using the runtime-native Neon driver, imported lazily. */
export async function createNeonPool(
  options: NeonPoolConnectionOptions,
): Promise<NeonPool> {
  const config = neonPoolConfigFromOptions(options);

  try {
    const mod = await loadNeonDriver();
    return new mod.Pool(config) as NeonPool;
  } catch (error) {
    throw new NeonError("Neon pool creation failed", {
      code: "NEON_CONNECTION_FAILED",
      cause: error,
    });
  }
}

/** Creates and connects a Neon `Client` using `jsr:@neon/serverless`. */
export async function createNeonClient(
  options: NeonClientConnectionOptions,
): Promise<NeonClient> {
  const config = neonClientConfigFromOptions(options);

  try {
    const mod = await loadNeonDriver();
    const client = new mod.Client(config) as NeonClient & {
      connect(): Promise<void>;
    };
    await client.connect();
    return client;
  } catch (error) {
    throw new NeonError("Neon client connection failed", {
      code: "NEON_CONNECTION_FAILED",
      cause: error,
    });
  }
}

/** Extracts a Neon `PoolConfig` from package connection options. */
export function neonPoolConfigFromOptions(
  options: NeonPoolConnectionOptions,
): NeonPoolConfig {
  const { url: _url, ...config } = options;

  return {
    ...config,
    connectionString: resolveNeonConnectionString(options),
  };
}

/** Extracts a Neon `ClientConfig` from package connection options. */
export function neonClientConfigFromOptions(
  options: NeonClientConnectionOptions,
): NeonClientConfig {
  const { url: _url, ...config } = options;

  return {
    ...config,
    connectionString: resolveNeonConnectionString(options),
  };
}

/** Resolves `url` or `connectionString` into a non-empty connection string. */
export function resolveNeonConnectionString(
  options: { readonly url?: string; readonly connectionString?: string },
): string {
  const connectionString = options.connectionString ?? options.url;

  if (connectionString === undefined || connectionString.trim().length === 0) {
    throw new NeonError("Neon connection url is required", {
      code: "NEON_DRIVER_MISSING",
    });
  }

  return connectionString;
}

/** Normalizes a Neon query result into Sisal's affected-row shape. */
export function normalizeNeonResult<Row>(
  result: NeonQueryResult<Row>,
): { readonly rows: Row[]; readonly rowCount: number } {
  return {
    rows: result.rows,
    rowCount: typeof result.rowCount === "number"
      ? result.rowCount
      : result.rows.length,
  };
}
