import { Buffer } from "node:buffer";

import type {
  MysqlClient,
  MysqlDriverRows,
  MysqlPool,
  MysqlResultHeader,
} from "./pool.ts";

// The subset of the MariaDB Connector/Node.js surface this adapter uses.
// `query()` resolves rows directly (an array for reads, an OkPacket-shaped
// header for writes) rather than mysql2's `[rows, fields]` tuple.
interface MariadbConnection {
  query(sql: string, params?: unknown[]): Promise<unknown>;
  release?(): Promise<void> | void;
  end?(): Promise<void>;
}

interface MariadbPool {
  getConnection(): Promise<MariadbConnection>;
  end?(): Promise<void>;
}

/**
 * Adapts a MariaDB Connector/Node.js pool to the adapter's {@link MysqlPool}
 * contract: `query()` results are re-shaped into mysql2's `[rows, fields]`
 * tuple (an OkPacket-style `affectedRows` object becomes a
 * {@link MysqlResultHeader}), so the executor treats both drivers
 * identically. Exported for tests; use {@link createMariadbPool} to open one.
 */
export function adaptMariadbPool(pool: MariadbPool): MysqlPool {
  return {
    async getConnection(): Promise<MysqlClient> {
      const connection = await pool.getConnection();
      return {
        async query<Row = Record<string, unknown>>(
          sql: string,
          params?: unknown[],
        ): Promise<[MysqlDriverRows<Row>, unknown]> {
          const result = await connection.query(
            sql,
            params?.map(toMariadbParam),
          );
          return [normalizeMariadbResult<Row>(result), undefined];
        },
        release(): void {
          void connection.release?.();
        },
        async end(): Promise<void> {
          await connection.end?.();
        },
      };
    },

    async end(): Promise<void> {
      await pool.end?.();
    },
  };
}

// The MariaDB connector only treats Node `Buffer`s as binary — a plain
// `Uint8Array` parameter is serialized as a JSON object (`{"0":7,…}`),
// silently corrupting BLOB writes (caught live by the B4 probe). Re-view
// binary params as Buffers (no copy); mysql2 needs no such help.
function toMariadbParam(value: unknown): unknown {
  if (value instanceof Uint8Array && !Buffer.isBuffer(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return value;
}

function normalizeMariadbResult<Row>(result: unknown): MysqlDriverRows<Row> {
  if (Array.isArray(result)) {
    return result as Row[];
  }
  const header = result as { affectedRows?: number; insertId?: unknown };
  return {
    affectedRows: header.affectedRows ?? 0,
    ...(header.insertId === undefined
      ? {}
      : { insertId: header.insertId as number | string | bigint }),
  } as MysqlResultHeader;
}

/**
 * Creates a {@link MysqlPool} backed by the MariaDB Connector/Node.js
 * (`npm:mariadb`) — the fastest driver in the v0.6 C6 benchmarks and the
 * opt-in alternative to the mysql2 default
 * (`connect({ driver: "mariadb" })`). The module is resolved through a
 * **runtime-computed specifier**, so the LGPL-licensed connector stays a
 * soft, run-time-only dependency — never part of the package's static module
 * graph or lockfile (the same pattern as `@sisal/pg`'s postgres.js opt-in).
 *
 * The pool sets the mysql2-compatible `supportBigNumbers` +
 * `bigNumberStrings` options the C6 survey mandates, so `BIGINT` reads back
 * as a precision-safe string on either driver.
 */
export function createMariadbPool(options: {
  readonly url: string;
  readonly connectionLimit?: number;
}): MysqlPool {
  let opening: Promise<MysqlPool> | undefined;

  const open = (): Promise<MysqlPool> => {
    return opening ??= (async () => {
      // Runtime-computed specifier: opaque to static analysis, so the LGPL
      // connector is a soft dependency resolved only when actually used.
      const specifier = ["npm:", "mariadb@^3.5.3"].join("");
      const mod = await import(specifier) as unknown as {
        default: { createPool(config: Record<string, unknown>): MariadbPool };
      };
      const parsed = new URL(options.url);
      return adaptMariadbPool(mod.default.createPool({
        host: parsed.hostname,
        port: parsed.port === "" ? 3306 : Number(parsed.port),
        user: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
        database: parsed.pathname.replace(/^\//, ""),
        connectionLimit: options.connectionLimit ?? 5,
        supportBigNumbers: true,
        bigNumberStrings: true,
        // Match the mysql2 pool: temporal columns read back as literal text
        // (see `mysqlConfigFromUrl`).
        dateStrings: true,
      }));
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
