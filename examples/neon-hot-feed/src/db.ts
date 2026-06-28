/**
 * Connection helpers for the Neon hot-feed example.
 *
 * Two connection roles, deliberately separated (see the README "Important Neon
 * note"):
 *
 * - {@link openDb} uses `DATABASE_URL` — the app/runtime path. Prefer the
 *   pooled Neon URL here. Every runtime query in this example is a single,
 *   self-contained statement, which is exactly what the Neon serverless /
 *   Deno Deploy story is good at.
 * - {@link openAdminDb} uses `DATABASE_DIRECT_URL` (falling back to
 *   `DATABASE_URL`) — migrations and admin work, where a direct connection is
 *   commonly preferred.
 *
 * @module
 */

import { connect, type NeonDatabase } from "@sisal/neon";

export type { NeonDatabase };

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
        `with --env-file=.env (the bundled deno tasks already do this).`,
    );
  }
  return value;
}

/** The app/runtime connection string (pooled URL recommended for Neon). */
export function getDatabaseUrl(): string {
  return requireEnv("DATABASE_URL");
}

/** The migrations/admin connection string; direct URL preferred on Neon. */
export function getDirectUrl(): string {
  return readEnv("DATABASE_DIRECT_URL") ?? getDatabaseUrl();
}

/** Opens the runtime database facade against `DATABASE_URL`. */
export function openDb(): Promise<NeonDatabase> {
  return connect({ url: getDatabaseUrl() });
}

/** Opens the admin database facade against `DATABASE_DIRECT_URL`. */
export function openAdminDb(): Promise<NeonDatabase> {
  return connect({ url: getDirectUrl() });
}
