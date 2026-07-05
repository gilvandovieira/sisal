import { OrmError } from "@sisal/orm";

import { createMariadbPool } from "./mariadb_pool.ts";

/**
 * Affected-row header mysql2 returns for mutations (`INSERT`/`UPDATE`/
 * `DELETE`), in place of a row array.
 */
export interface MysqlResultHeader {
  /** Number of rows affected by the mutation. */
  readonly affectedRows: number;
  /**
   * First `AUTO_INCREMENT` id the statement generated (0 when none).
   * mysql2 reports a number (a string past 2⁵³ with the mandated options);
   * the MariaDB connector reports a `bigint`.
   */
  readonly insertId?: number | string | bigint;
}

/** Row payload of a mysql2 result: an array for reads, a header for writes. */
export type MysqlDriverRows<Row = Record<string, unknown>> =
  | Row[]
  | MysqlResultHeader;

/**
 * Minimal MySQL client (one pooled connection) surface used by the adapter —
 * structurally compatible with a `mysql2/promise` `PoolConnection`. The
 * adapter executes through `query()` (the text protocol) rather than
 * `execute()` (binary prepared statements) because MySQL 8 rejects a bound
 * `LIMIT ?` on the binary protocol (`Incorrect arguments to
 * mysqld_stmt_execute`; MariaDB accepts it) — verified first-hand in the v0.7
 * B2 probes. A prepared-statement mode can come later as an opt-in.
 */
export interface MysqlClient {
  /** Runs SQL through the client connection. */
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<[MysqlDriverRows<Row>, unknown]>;

  /** Releases this client back to its pool, when pooled. */
  release?(): void;
  /** Closes the client connection. */
  end?(): Promise<void>;
}

/** Minimal MySQL pool surface used by the adapter (mysql2 `Pool`-shaped). */
export interface MysqlPool {
  /** Closes resources held by this mysql pool. */
  getConnection(): Promise<MysqlClient>;
  /** Closes resources held by this mysql pool. */
  end?(): Promise<void>;
}

/**
 * Which underlying driver a `@sisal/mysql` URL connection uses.
 *
 * - `"mysql2"` (default) — `npm:mysql2/promise`, the v0.6 C6 survey's choice
 *   (MIT, Deno + Node, no protocol stalls).
 * - `"mariadb"` — the MariaDB Connector/Node.js, the fastest driver in the C6
 *   benchmarks; LGPL-licensed, so it is a lazily-resolved **soft** dependency
 *   (see `createMariadbPool`).
 */
export type MysqlDriverKind = "mysql2" | "mariadb";

/**
 * TLS settings for a URL-based MySQL/MariaDB connection. Forwarded verbatim to
 * the driver's `ssl` config (mysql2 and the MariaDB connector accept the same
 * Node TLS fields), so a value here reaches Node's TLS layer directly. Use
 * `ssl: true` to require TLS with the platform's default CA verification, or an
 * object to pin a CA / client certificate / verification policy.
 */
export interface MysqlTlsOptions {
  /** Trusted CA certificate(s) (PEM). */
  readonly ca?: string | readonly string[];
  /** Client certificate chain(s) (PEM) for mutual TLS. */
  readonly cert?: string | readonly string[];
  /** Client private key(s) (PEM) for mutual TLS. */
  readonly key?: string | readonly string[];
  /** Passphrase for an encrypted private `key`. */
  readonly passphrase?: string;
  /**
   * Whether to reject a server whose certificate does not verify against `ca`.
   * Defaults to the driver default (`true`). Set `false` only for a trusted
   * private network with self-signed certs you accept.
   */
  readonly rejectUnauthorized?: boolean;
  /** Minimum TLS protocol version, e.g. `"TLSv1.2"`. */
  readonly minVersion?: string;
  /** Server name for SNI / certificate identity checks. */
  readonly servername?: string;
}

/** Connection options accepted by MySQL ORM adapter factories. */
export interface MysqlConnectionOptions {
  /** `mysql://user:password@host:port/database` connection URL. */
  readonly url?: string;
  /** An existing pool to use (not closed by the adapter). */
  readonly pool?: MysqlPool;
  /** A single existing connection to use (not closed by the adapter). */
  readonly client?: MysqlClient;
  /** Pool size when connecting by `url`; defaults to 5. */
  readonly connectionLimit?: number;
  /** Driver used when connecting by `url`; defaults to `"mysql2"`. */
  readonly driver?: MysqlDriverKind;
  /**
   * TLS for a URL connection. `true` requires TLS with default CA
   * verification; an object pins a CA / client certificate / policy (see
   * {@link MysqlTlsOptions}). Omitted, the connection is not encrypted. TLS
   * **cannot** be set through the URL query string — a `?ssl-mode=…` (or
   * similar) param is rejected rather than silently ignored, since the driver
   * would otherwise connect in cleartext. Applies to the `url` path only;
   * configure an injected `pool`/`client` yourself.
   */
  readonly ssl?: boolean | MysqlTlsOptions;
}

/** Resolved MySQL connection source with ownership metadata. */
export interface MysqlConnectionSource {
  readonly pool?: MysqlPool;
  readonly client?: MysqlClient;
  readonly ownsPool: boolean;
  readonly ownsClient: boolean;
}

/**
 * Creates a MySQL pool from a URL using `mysql2/promise`, imported **lazily**
 * on first use so the npm driver stays a runtime-only dependency (the same
 * discipline as `@sisal/libsql`'s client and `@sisal/pg`'s postgres.js
 * opt-in).
 *
 * The pool always sets `supportBigNumbers: true, bigNumberStrings: true` —
 * the v0.6 C6 survey measured mysql2's default `BIGINT` decode silently
 * truncating past 2⁵³; with the options a `BIGINT` reads back as a
 * precision-safe string, matching `columns.bigint()`'s inferred type and
 * `@sisal/neon`'s convention.
 */
export function createMysqlPool(options: {
  readonly url: string;
  readonly connectionLimit?: number;
  readonly ssl?: boolean | MysqlTlsOptions;
}): MysqlPool {
  let opening: Promise<MysqlPool> | undefined;

  const open = (): Promise<MysqlPool> => {
    return opening ??= (async () => {
      // deno-lint-ignore no-import-prefix
      const mod = await import("npm:mysql2@^3.22.5/promise") as unknown as {
        default: {
          createPool(config: Record<string, unknown>): MysqlPool;
        };
      };
      return mod.default.createPool(mysqlConfigFromUrl(options));
    })();
  };

  return {
    async getConnection(): Promise<MysqlClient> {
      return (await open()).getConnection();
    },

    async end(): Promise<void> {
      if (opening === undefined) {
        return;
      }
      await (await opening).end?.();
    },
  };
}

// TLS is security-sensitive and the drivers do not read it from the URL query
// string, so a `?ssl-mode=…` (or similar) param would silently connect in
// cleartext. Reject it and point the caller at the typed `ssl` option (SEC-009).
const SSL_URL_PARAMS: ReadonlySet<string> = new Set([
  "ssl",
  "sslmode",
  "ssl-mode",
  "usessl",
  "requiressl",
  "sslaccept",
]);

/** Rejects TLS-related URL query params so they cannot fail open to cleartext. */
export function assertNoUrlSslParams(parsed: URL): void {
  for (const key of parsed.searchParams.keys()) {
    if (SSL_URL_PARAMS.has(key.toLowerCase())) {
      throw new OrmError(
        `TLS cannot be configured through the connection URL (found "${key}"). ` +
          `Pass the \`ssl\` option instead — the driver ignores URL TLS params, ` +
          `so leaving this here would connect in cleartext.`,
        { code: "ORM_INVALID_QUERY", status: 400 },
      );
    }
  }
}

// Maps the portable `ssl` option to a driver `ssl` config: `true` enables TLS
// with default verification (mysql2 treats an empty object as "TLS on"); an
// object is forwarded verbatim.
function mysql2SslConfig(
  ssl: boolean | MysqlTlsOptions | undefined,
): Record<string, unknown> {
  if (ssl === undefined) return {};
  return { ssl: ssl === true ? {} : ssl };
}

/**
 * Parses a `mysql://` URL into a mysql2 pool config with the mandated decode
 * options applied. Exported for tests. The `flags: ["-FOUND_ROWS"]` entry is
 * load-bearing, not cosmetic — see the affected-row note below.
 */
export function mysqlConfigFromUrl(options: {
  readonly url: string;
  readonly connectionLimit?: number;
  readonly ssl?: boolean | MysqlTlsOptions;
}): Record<string, unknown> {
  let parsed: URL;
  try {
    parsed = new URL(options.url);
  } catch (error) {
    throw new OrmError("Invalid MySQL connection url", {
      code: "ORM_DRIVER_MISSING",
      status: 400,
      cause: error,
    });
  }
  assertNoUrlSslParams(parsed);

  return {
    host: parsed.hostname,
    port: parsed.port === "" ? 3306 : Number(parsed.port),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ""),
    connectionLimit: options.connectionLimit ?? 5,
    supportBigNumbers: true,
    bigNumberStrings: true,
    // DATE/DATETIME/TIMESTAMP read back as the server's literal text, not a
    // client-local `Date`: a driver `Date` silently shifts server-generated
    // values by the client/server timezone delta, while the string is exact
    // bytes — and it is what the column `mode` contracts and the opt-in
    // Temporal layer expect (the same shape the pg and SQLite families see).
    dateStrings: true,
    // Disable `CLIENT_FOUND_ROWS` (mysql2 enables it by default). With it on, a
    // conflicting no-op `INSERT … ON DUPLICATE KEY UPDATE` reports one *found*
    // row instead of zero *changed* rows, so `tryInsert`'s affected-row signal
    // cannot tell an insert from a conflict and the advisory-lock claim can
    // double-grant (SEC-008). Off, the affected-row count is "rows changed",
    // matching the write-outcome contract. Trade-off: a plain `UPDATE` that
    // sets a row to its current values now reports 0 rather than 1 — documented
    // in docs/mysql-compatibility.md.
    flags: ["-FOUND_ROWS"],
    ...mysql2SslConfig(options.ssl),
  };
}

/** Resolves a MySQL pool, client, or URL into a connection source. */
export function resolveMysqlConnectionSource(
  options: MysqlConnectionOptions,
): MysqlConnectionSource {
  if (options.pool !== undefined && options.client !== undefined) {
    throw new OrmError("Configure either a MySQL pool or client, not both", {
      code: "ORM_INVALID_QUERY",
      status: 400,
    });
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
    throw new OrmError("MySQL connection url is required", {
      code: "ORM_DRIVER_MISSING",
      status: 400,
    });
  }

  const poolOptions = {
    url: options.url,
    ...(options.connectionLimit === undefined
      ? {}
      : { connectionLimit: options.connectionLimit }),
    ...(options.ssl === undefined ? {} : { ssl: options.ssl }),
  };
  return {
    pool: options.driver === "mariadb"
      ? createMariadbPool(poolOptions)
      : createMysqlPool(poolOptions),
    ownsPool: true,
    ownsClient: false,
  };
}
