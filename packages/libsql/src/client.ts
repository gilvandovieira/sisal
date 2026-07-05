/** Shared structural libSQL/Turso client contracts and lazy client opening. */

/** Integer conversion mode accepted by `@libsql/client`. */
export type LibsqlIntMode = "number" | "bigint" | "string";

/** Transaction mode accepted by `@libsql/client`. */
export type LibsqlTransactionMode = "write" | "read" | "deferred";

/** Scalar value shape returned by libSQL rows. */
export type LibsqlValue = null | string | number | bigint | ArrayBuffer;

/** Input value shape accepted by libSQL statements. */
export type LibsqlInValue = LibsqlValue | boolean | Uint8Array | Date;

/** Positional or named libSQL statement arguments. */
export type LibsqlArgs =
  | LibsqlInValue[]
  | Record<string, LibsqlInValue>;

/** Statement shape accepted by libSQL clients. */
export interface LibsqlStatement {
  readonly sql: string;
  readonly args?: LibsqlArgs;
}

/** Result set shape returned by libSQL clients. */
export interface LibsqlResultSet<Row = Record<string, unknown>> {
  readonly rows: Row[];
  readonly rowsAffected?: number;
}

/** Interactive transaction surface used by Sisal. */
export interface LibsqlTransaction {
  execute<Row = Record<string, unknown>>(
    statement: LibsqlStatement,
  ): Promise<LibsqlResultSet<Row>>;

  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): void;
}

/** Minimal libSQL/Turso client surface used by the adapter. */
export interface LibsqlClient {
  execute<Row = Record<string, unknown>>(
    statement: LibsqlStatement | string,
    args?: LibsqlArgs,
  ): Promise<LibsqlResultSet<Row>>;

  transaction?(mode?: LibsqlTransactionMode): Promise<LibsqlTransaction>;
  close?(): void | Promise<void>;
}

/** Client config forwarded to `@libsql/client`. */
export interface LibsqlClientConfig {
  readonly url: string;
  readonly authToken?: string;
  readonly encryptionKey?: string;
  readonly remoteEncryptionKey?: string;
  readonly syncUrl?: string;
  readonly syncInterval?: number;
  readonly readYourWrites?: boolean;
  readonly offline?: boolean;
  readonly tls?: boolean;
  readonly intMode?: LibsqlIntMode;
  readonly fetch?: unknown;
  readonly concurrency?: number;
  readonly timeout?: number;
}

/** Connection options accepted by libSQL adapter factories. */
export interface LibsqlConnectionOptions extends Partial<LibsqlClientConfig> {
  readonly client?: LibsqlClient;
}

/** Returns true when a URL should use the libSQL client transport. */
export function isLibsqlUrl(url: string | undefined): boolean {
  if (url === undefined) {
    return false;
  }

  return /^(libsql|https?|wss?|file):/i.test(url.trim());
}

/** Extracts a concrete libSQL client config from connection options. */
export function libsqlConfigFromOptions(
  options: LibsqlConnectionOptions,
): LibsqlClientConfig | undefined {
  const url = options.url?.trim();

  if (url === undefined || url.length === 0) {
    return undefined;
  }

  return {
    url,
    ...(options.authToken === undefined
      ? {}
      : { authToken: options.authToken }),
    ...(options.encryptionKey === undefined
      ? {}
      : { encryptionKey: options.encryptionKey }),
    ...(options.remoteEncryptionKey === undefined
      ? {}
      : { remoteEncryptionKey: options.remoteEncryptionKey }),
    ...(options.syncUrl === undefined ? {} : { syncUrl: options.syncUrl }),
    ...(options.syncInterval === undefined
      ? {}
      : { syncInterval: options.syncInterval }),
    ...(options.readYourWrites === undefined
      ? {}
      : { readYourWrites: options.readYourWrites }),
    ...(options.offline === undefined ? {} : { offline: options.offline }),
    ...(options.tls === undefined ? {} : { tls: options.tls }),
    ...(options.intMode === undefined ? {} : { intMode: options.intMode }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.concurrency === undefined
      ? {}
      : { concurrency: options.concurrency }),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
  };
}

/** Opens a libSQL/Turso client with `@libsql/client`, imported lazily. */
export async function createLibsqlClient(
  config: LibsqlClientConfig,
): Promise<LibsqlClient> {
  // deno-lint-ignore no-import-prefix
  const mod = await import("npm:@libsql/client@^0.17.4") as unknown as {
    createClient(config: LibsqlClientConfig): LibsqlClient;
  };

  return mod.createClient(config);
}
