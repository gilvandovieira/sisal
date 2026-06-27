/** Shared structural Neon serverless client contracts and lazy client opening. */

import type {
  ClientConfig as NeonClientConfig,
  PoolConfig as NeonPoolConfig,
} from "@neon/serverless";

export type {
  ClientConfig as NeonClientConfig,
  PoolConfig as NeonPoolConfig,
  QueryResult as NeonDriverQueryResult,
  QueryResultRow as NeonQueryResultRow,
} from "@neon/serverless";

/** Error codes emitted by the Neon compatibility package. */
export type NeonErrorCode =
  | "NEON_INVALID"
  | "NEON_DRIVER_MISSING"
  | "NEON_CONNECTION_FAILED"
  | "NEON_EXECUTE_FAILED";

/** Structured error thrown by Neon compatibility helpers. */
export class NeonError extends Error {
  readonly code: NeonErrorCode;
  readonly details?: Record<string, unknown>;

  /** Creates a Neon compatibility error with optional details and cause. */
  constructor(
    message: string,
    options: {
      readonly code: NeonErrorCode;
      readonly details?: Record<string, unknown>;
      readonly cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "NeonError";
    this.code = options.code;
    this.details = options.details;
  }
}

/** Result shape returned by Neon query-capable handles. */
export interface NeonQueryResult<Row = Record<string, unknown>> {
  readonly rows: Row[];
  readonly rowCount?: number | null;
}

/** Minimal Neon query surface used by the adapter. */
export interface NeonQueryable {
  query<Row = Record<string, unknown>>(
    query: string,
    args?: unknown[],
  ): Promise<NeonQueryResult<Row>>;
}

/** Minimal Neon client surface used by transactions. */
export interface NeonClient extends NeonQueryable {
  release?(): void;
  end?(): Promise<void>;
}

/** Minimal Neon pool surface used by the adapter. */
export interface NeonPool extends NeonQueryable {
  connect(): Promise<NeonClient>;
  end?(): Promise<void>;
}

/** Connection options forwarded to Neon `Pool`, with `url` as an alias. */
export interface NeonPoolConnectionOptions extends NeonPoolConfig {
  readonly url?: string;
}

/** Connection options forwarded to Neon `Client`, with `url` as an alias. */
export interface NeonClientConnectionOptions extends NeonClientConfig {
  readonly url?: string;
}

/** Creates a Neon `Pool` using `jsr:@neon/serverless`, imported lazily. */
export async function createNeonPool(
  options: NeonPoolConnectionOptions,
): Promise<NeonPool> {
  const config = neonPoolConfigFromOptions(options);

  try {
    const mod = await import("@neon/serverless");
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
    const mod = await import("@neon/serverless");
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
