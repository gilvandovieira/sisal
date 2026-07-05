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
  /** Bound parameters used by this libsql statement. */
  readonly sql: string;
  /** Bound parameters used by this libsql statement. */
  readonly args?: LibsqlArgs;
}

/** Result set shape returned by libSQL clients. */
export interface LibsqlResultSet<Row = Record<string, unknown>> {
  /** rows affected for this libsql result set. */
  readonly rows: Row[];
  /** rows affected for this libsql result set. */
  readonly rowsAffected?: number;
}

/** Interactive transaction surface used by Sisal. */
export interface LibsqlTransaction {
  /** Executes SQL through this libsql transaction. */
  execute<Row = Record<string, unknown>>(
    statement: LibsqlStatement,
  ): Promise<LibsqlResultSet<Row>>;
  /** Commits this libsql transaction. */

  /** Rolls back this libsql transaction. */
  commit(): Promise<void>;
  /** Closes resources held by this libsql transaction. */
  rollback(): Promise<void>;
  /** Closes resources held by this libsql transaction. */
  close(): void;
}

/** Minimal libSQL/Turso client surface used by the adapter. */
export interface LibsqlClient {
  /** Executes SQL through this libsql client. */
  execute<Row = Record<string, unknown>>(
    statement: LibsqlStatement | string,
    args?: LibsqlArgs,
  ): Promise<LibsqlResultSet<Row>>;
  /** Runs work inside a transaction for this libsql client. */

  /** Closes resources held by this libsql client. */
  transaction?(mode?: LibsqlTransactionMode): Promise<LibsqlTransaction>;
  /** Closes resources held by this libsql client. */
  close?(): void | Promise<void>;
}

/** Client config forwarded to `@libsql/client`. */
export interface LibsqlClientConfig {
  /** Authentication token used by this libsql client config. */
  readonly url: string;
  /** encryption key used by this libsql client config. */
  readonly authToken?: string;
  /** remote encryption key used by this libsql client config. */
  readonly encryptionKey?: string;
  /** sync url for this libsql client config. */
  readonly remoteEncryptionKey?: string;
  /** sync interval for this libsql client config. */
  readonly syncUrl?: string;
  /** read your writes for this libsql client config. */
  readonly syncInterval?: number;
  /** offline for this libsql client config. */
  readonly readYourWrites?: boolean;
  /** tls for this libsql client config. */
  readonly offline?: boolean;
  /** int mode for this libsql client config. */
  readonly tls?: boolean;
  /** fetch for this libsql client config. */
  readonly intMode?: LibsqlIntMode;
  /** concurrency for this libsql client config. */
  readonly fetch?: unknown;
  /** timeout for this libsql client config. */
  readonly concurrency?: number;
  /** timeout for this libsql client config. */
  readonly timeout?: number;
}

/** Connection options accepted by libSQL adapter factories. */
export interface LibsqlConnectionOptions extends Partial<LibsqlClientConfig> {
  /** client for this libsql connection options. */
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
