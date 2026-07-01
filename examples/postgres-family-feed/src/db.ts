/**
 * Connection helpers for the PostgreSQL-**family** rising-feed example.
 *
 * One example, three drivers. The PostgreSQL dialect backs both `@sisal/pg`
 * (over pure-JSR `@db/postgres` or `npm:postgres`) and `@sisal/neon` (WebSocket
 * / serverless), and `NeonDatabase` is structurally identical to `PgDatabase`,
 * so **every other module in this example types its `db` as `PgDatabase` and
 * runs unchanged over all three** — only the connection differs. Pick one with
 * `SISAL_ADAPTER`:
 *
 * - `"pg"` (default) — `@sisal/pg` on `jsr:@db/postgres` (regular Postgres, TCP).
 * - `"pg-postgres-js"` — `@sisal/pg` on `npm:postgres` (the fast driver, 0.5.1+).
 * - `"neon"` — `@sisal/neon` over a WebSocket (Neon / serverless). Interactive
 *   transactions still work; the activity recorder keeps everything single-
 *   statement/database-local anyway (see `src/activity.ts`).
 *
 * Two connection roles are kept: {@link openDb} (`DATABASE_URL`, the app path)
 * and {@link openAdminDb} (`DATABASE_DIRECT_URL`, falling back to
 * `DATABASE_URL`, for migrations/admin — often the same string).
 *
 * @module
 */

import { connect as connectPg, type PgDatabase } from "@sisal/pg";
import { connect as connectNeon } from "@sisal/neon";

export type { PgDatabase };

/**
 * The family-wide database facade. `@sisal/pg` and `@sisal/neon` return
 * structurally identical facades, so one type serves every module here.
 */
export type FeedDatabase = PgDatabase;

/** Which PostgreSQL-family driver {@link openDb} opens. */
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
        `with --env-file=.env (the bundled deno tasks already do this). ` +
        `Start a local PostgreSQL with: docker compose up -d`,
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
 * WebSocket proxy. A no-op against real Neon (secure WebSocket, no `proxy`).
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
      // `NeonDatabase` is structurally identical to `PgDatabase`.
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
