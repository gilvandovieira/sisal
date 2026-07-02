/**
 * Connection helpers for the MySQL-**family** rising-feed example.
 *
 * One example, two drivers. The MySQL dialect backs both MySQL proper and
 * MariaDB through `@sisal/mysql`; pick the runtime driver with `SISAL_ADAPTER`:
 *
 * - `"mysql2"` (default) — `npm:mysql2`.
 * - `"mariadb"` — MariaDB Connector/Node.js.
 *
 * @module
 */

import {
  connect,
  type MysqlDatabase,
  type MysqlDriverKind,
} from "@sisal/mysql";

export type { MysqlDatabase };

/** The family-wide database facade. */
export type FeedDatabase = MysqlDatabase;

/** Which MySQL-family driver {@link openDb} opens. */
export type FeedAdapter = MysqlDriverKind;

/** Reads an environment variable, tolerating a missing `--allow-env`. */
export function readEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

/** Returns a required environment variable or throws a helpful error. */
export function requireEnv(name: string): string {
  const value = readEnv(name);
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and fill it in, then run ` +
        `with --env-file=.env (the bundled deno tasks already do this). ` +
        `Start local databases with: docker compose up -d`,
    );
  }
  return value;
}

/** The selected driver, from `SISAL_ADAPTER` (defaults to `"mysql2"`). */
export function getAdapter(): FeedAdapter {
  const raw = (readEnv("SISAL_ADAPTER") ?? "mysql2").trim();
  if (raw === "mysql2" || raw === "mariadb") return raw;
  throw new Error(
    `Unknown SISAL_ADAPTER "${raw}"; use "mysql2" or "mariadb".`,
  );
}

/** The runtime connection string. */
export function getDatabaseUrl(): string {
  return readEnv("MYSQL_URL") ?? readEnv("MARIADB_URL") ??
    requireEnv("DATABASE_URL");
}

/** Opens the database facade against the configured driver. */
export function openDb(): Promise<MysqlDatabase> {
  return connect({ url: getDatabaseUrl(), driver: getAdapter() });
}

/** Admin and runtime use the same MySQL-family connection in this example. */
export const openAdminDb = openDb;
