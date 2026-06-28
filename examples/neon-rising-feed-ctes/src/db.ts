/**
 * Connection helpers for the Neon rising-feed (CTE) example.
 *
 * Two connection roles, kept for structural parity with the other Neon
 * examples:
 *
 * - {@link openDb} uses `DATABASE_URL` — the app/runtime + demo path. Prefer the
 *   pooled Neon URL here. Every runtime mutation in this example is a single
 *   (large) parameterized statement built from CTEs, which is exactly what the
 *   Neon serverless / Deno Deploy story is good at.
 * - {@link openAdminDb} uses `DATABASE_DIRECT_URL` (falling back to
 *   `DATABASE_URL`) — migrations and admin work.
 *
 * Timestamps use `mode: "date"` (JS `Date`); raw CTE results come back
 * driver-shaped (`@neon/serverless` returns `timestamptz` as `Date` and
 * `double precision` as `number`), so no Temporal parsing is configured here.
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
