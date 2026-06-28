/**
 * Connection helper for the libSQL/Turso rising-feed example.
 *
 * Unlike the Neon sibling there is no pooled-vs-direct split: libSQL is either a
 * local SQLite file or a remote Turso endpoint, reached the same way. By default
 * the example uses a local file so you can run it with zero configuration; set
 * `TURSO_DATABASE_URL` (+ `TURSO_AUTH_TOKEN`) to point at Turso instead.
 *
 * @module
 */

import { connect, type LibsqlDatabase } from "@sisal/libsql";

export type { LibsqlDatabase };

/** Reads an environment variable, tolerating a missing `--allow-env`. */
export function readEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

/** The libSQL/Turso URL, defaulting to a local SQLite file. */
export function getDatabaseUrl(): string {
  return readEnv("TURSO_DATABASE_URL") ??
    readEnv("SISAL_LIBSQL_URL") ??
    "file:./sisal-rising-feed.db";
}

/** Opens the database facade against the configured URL (or the local file). */
export function openDb(): Promise<LibsqlDatabase> {
  const url = getDatabaseUrl();
  const authToken = readEnv("TURSO_AUTH_TOKEN");
  return connect(authToken === undefined ? { url } : { url, authToken });
}

/**
 * libSQL has no pooled/direct distinction, so admin and runtime use the same
 * connection. Kept as a named export so the example mirrors the Neon sibling.
 */
export const openAdminDb = openDb;
