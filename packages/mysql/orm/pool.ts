import { OrmError } from "@sisal/orm";

import { createMariadbPool } from "./mariadb_pool.ts";

/**
 * Affected-row header mysql2 returns for mutations (`INSERT`/`UPDATE`/
 * `DELETE`), in place of a row array.
 */
export interface MysqlResultHeader {
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
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<[MysqlDriverRows<Row>, unknown]>;

  release?(): void;
  end?(): Promise<void>;
}

/** Minimal MySQL pool surface used by the adapter (mysql2 `Pool`-shaped). */
export interface MysqlPool {
  getConnection(): Promise<MysqlClient>;
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

// Parses a mysql:// URL into a mysql2 pool config with the mandated decode
// options applied.
function mysqlConfigFromUrl(options: {
  readonly url: string;
  readonly connectionLimit?: number;
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
  };
  return {
    pool: options.driver === "mariadb"
      ? createMariadbPool(poolOptions)
      : createMysqlPool(poolOptions),
    ownsPool: true,
    ownsClient: false,
  };
}
