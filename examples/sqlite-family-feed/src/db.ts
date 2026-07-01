/**
 * Connection helper for the SQLite-**family** rising-feed example.
 *
 * One example, two drivers. The SQLite dialect backs both `@sisal/libsql`
 * (libSQL / Turso — a local `file:` or a remote endpoint) and `@sisal/sqlite`
 * (embedded `@db/sqlite`), and `SqliteDatabase` is structurally identical to
 * `LibsqlDatabase`, so **every other module types its `db` as `LibsqlDatabase`
 * and runs unchanged over both** — only the connection differs. Pick one with
 * `SISAL_ADAPTER`:
 *
 * - `"libsql"` (default) — `@sisal/libsql`. A local SQLite file by default (zero
 *   config); set `TURSO_DATABASE_URL` (+ `TURSO_AUTH_TOKEN`) to reach Turso.
 * - `"sqlite"` — embedded `@sisal/sqlite` over `@db/sqlite` (FFI). The file path
 *   comes from `SISAL_SQLITE_PATH` (defaults to a local `.sqlite` file).
 *
 * There is no pooled/direct split in the SQLite family, so admin and runtime
 * share one connection.
 *
 * @module
 */

import { connect as connectLibsql, type LibsqlDatabase } from "@sisal/libsql";
import { connect as connectSqlite } from "@sisal/sqlite";

export type { LibsqlDatabase };

/** The family-wide database facade; libSQL and embedded SQLite are identical. */
export type FeedDatabase = LibsqlDatabase;

/** Which SQLite-family driver {@link openDb} opens. */
export type FeedAdapter = "libsql" | "sqlite";

/** Reads an environment variable, tolerating a missing `--allow-env`. */
export function readEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

/** The selected driver, from `SISAL_ADAPTER` (defaults to `"libsql"`). */
export function getAdapter(): FeedAdapter {
  const raw = (readEnv("SISAL_ADAPTER") ?? "libsql").trim();
  if (raw === "libsql" || raw === "sqlite") {
    return raw;
  }
  throw new Error(`Unknown SISAL_ADAPTER "${raw}"; use "libsql" or "sqlite".`);
}

/** The libSQL/Turso URL, defaulting to a local SQLite file. */
export function getDatabaseUrl(): string {
  return readEnv("TURSO_DATABASE_URL") ??
    readEnv("SISAL_LIBSQL_URL") ??
    "file:./sisal-rising-feed.db";
}

/** The embedded-`@sisal/sqlite` file path. */
export function getSqlitePath(): string {
  return readEnv("SISAL_SQLITE_PATH") ?? "./sisal-rising-feed.sqlite";
}

/** Opens the database facade against the configured driver. */
export function openDb(): Promise<LibsqlDatabase> {
  if (getAdapter() === "sqlite") {
    // `SqliteDatabase` is structurally identical to `LibsqlDatabase`.
    return connectSqlite({ path: getSqlitePath() });
  }
  const url = getDatabaseUrl();
  const authToken = readEnv("TURSO_AUTH_TOKEN");
  return connectLibsql(authToken === undefined ? { url } : { url, authToken });
}

/**
 * The SQLite family has no pooled/direct distinction, so admin and runtime use
 * the same connection. Kept as a named export for parity with the sibling.
 */
export const openAdminDb = openDb;
