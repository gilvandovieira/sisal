/**
 * Connection helpers for the PostgreSQL-**family** activity-vectors example.
 *
 * Runs over any PostgreSQL-family driver — `@sisal/pg` on `@db/postgres` or
 * `npm:postgres`, or `@sisal/neon` over a WebSocket — selected by `SISAL_ADAPTER`
 * (`pg` default | `pg-postgres-js` | `neon`). `NeonDatabase` ≡ `PgDatabase`, so
 * every other module runs unchanged.
 *
 * - {@link openDb} uses `DATABASE_URL` — the app/runtime path.
 * - {@link openAdminDb} uses `DATABASE_DIRECT_URL` (falling back to
 *   `DATABASE_URL`) — migrations and admin work.
 *
 * @module
 */

import { connect as connectPg, type PgDatabase } from "@sisal/pg";
import { connect as connectNeon } from "@sisal/neon";

export type { PgDatabase };

/** The family database facade; `@sisal/pg` and `@sisal/neon` are identical. */
export type NeonDatabase = PgDatabase;

/** Which PostgreSQL-family driver {@link openDb} opens, from `SISAL_ADAPTER`. */
export type FeedAdapter = "pg" | "pg-postgres-js" | "neon";

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

/** The app/runtime connection string. */
export function getDatabaseUrl(): string {
  return requireEnv("DATABASE_URL");
}

/** The migrations/admin connection string; same as DATABASE_URL by default. */
export function getDirectUrl(): string {
  return readEnv("DATABASE_DIRECT_URL") ?? getDatabaseUrl();
}

/** The selected driver, from `SISAL_ADAPTER` (defaults to `"pg"`). */
export function getAdapter(): FeedAdapter {
  const raw = (readEnv("SISAL_ADAPTER") ?? "pg").trim();
  if (raw === "pg" || raw === "pg-postgres-js" || raw === "neon") {
    return raw;
  }
  throw new Error(
    `Unknown SISAL_ADAPTER "${raw}"; use "pg", "pg-postgres-js", or "neon".`,
  );
}

/**
 * When testing the `neon` adapter against a local Postgres behind the
 * `neon-proxy` (docker compose), point `@neon/serverless` at the insecure
 * WebSocket proxy. A no-op against real Neon.
 */
async function configureNeonProxy(): Promise<void> {
  const wsProxy = readEnv("NEON_WS_PROXY");
  if (wsProxy === undefined) return;
  const mod = await import("@neon/serverless");
  const cfg = (mod as unknown as { neonConfig: Record<string, unknown> })
    .neonConfig;
  cfg.wsProxy = () => `${wsProxy}/v1`;
  cfg.useSecureWebSocket = false;
  cfg.pipelineTLS = false;
  cfg.pipelineConnect = false;
}

async function open(url: string): Promise<PgDatabase> {
  switch (getAdapter()) {
    case "neon": {
      await configureNeonProxy();
      return await connectNeon({ url });
    }
    case "pg-postgres-js":
      return await connectPg({ url, driver: "postgres-js" });
    default:
      return await connectPg({ url });
  }
}

/** Opens the runtime database facade against `DATABASE_URL`. */
export function openDb(): Promise<PgDatabase> {
  return open(getDatabaseUrl());
}

/** Opens the admin database facade against `DATABASE_DIRECT_URL`. */
export function openAdminDb(): Promise<PgDatabase> {
  return open(getDirectUrl());
}
