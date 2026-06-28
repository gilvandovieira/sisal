/**
 * Connection helpers for the normal-PostgreSQL rising-feed example.
 *
 * This is the "normal database" version: a regular PostgreSQL 18 TCP/session
 * connection via `@sisal/pg`. There is no Neon serverless / single-statement
 * constraint, so interactive transactions are perfectly fine here (see the
 * README comparison and `recordPostActivityWithTransaction` in src/activity.ts).
 *
 * Two connection roles are kept for structural parity with the Neon example:
 *
 * - {@link openDb} uses `DATABASE_URL` — the app/runtime path.
 * - {@link openAdminDb} uses `DATABASE_DIRECT_URL` (falling back to
 *   `DATABASE_URL`) — migrations and admin work. For normal Postgres these are
 *   usually the same connection string.
 *
 * @module
 */

import { connect, type PgDatabase } from "@sisal/pg";

export type { PgDatabase };

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
        `Start a local PostgreSQL 18 with: docker compose up -d`,
    );
  }
  return value;
}

/** The app/runtime connection string. */
export function getDatabaseUrl(): string {
  return requireEnv("DATABASE_URL");
}

/** The migrations/admin connection string; same as DATABASE_URL by default. */
export function getDirectUrl(): string {
  return readEnv("DATABASE_DIRECT_URL") ?? getDatabaseUrl();
}

/** Opens the runtime database facade against `DATABASE_URL`. */
export function openDb(): Promise<PgDatabase> {
  return connect({ url: getDatabaseUrl() });
}

/** Opens the admin database facade against `DATABASE_DIRECT_URL`. */
export function openAdminDb(): Promise<PgDatabase> {
  return connect({ url: getDirectUrl() });
}
