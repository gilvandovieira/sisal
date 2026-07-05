/**
 * A portable, **lightweight** advisory lock — a lock-row lease used as a coarse
 * whole-job mutual-exclusion primitive (the v0.6 A2 / contract-08 substrate a
 * future `@sisal/etl` runner consumes so two runs never process the same window
 * twice).
 *
 * Unlike a session-scoped `pg_advisory_lock` / MySQL `GET_LOCK`, a held lock
 * keeps **no connection and no server-side lock** between acquire and release:
 * the claim is a single row in `sisal_advisory_locks` carrying an expiry lease,
 * so holding the lock costs nothing while the run proceeds on the normal pool.
 * The trade-off is that a crashed holder's row lingers until its lease lapses —
 * at which point another claimant may steal it — so long runs should
 * {@link AdvisoryLock.renew} and treat a failed renew as "lock lost". Uniform
 * across every Sisal engine; the SQL is plain, dialect-rendered DML.
 *
 * Part of the `@sisal/orm` core; surfaced as {@link Database.tryAdvisoryLock}.
 *
 * @module
 */

import { and, columns, defineTable, eq, lte, OrmError, raw } from "@sisal/core";
import type { SqlDialect } from "@sisal/core";
// Type-only import — `database.ts` value-imports this module, so a value edge
// back would be a cycle; the erased type edge is safe.
import type { Database } from "./database.ts";

/** Default physical name of the lock-registry table backing the lock. */
const DEFAULT_ADVISORY_LOCK_TABLE = "sisal_advisory_locks";

// Same policy the migration history store uses for a custom table name: a plain,
// unqualified SQL identifier. Validated (not quoted) so it is safe to
// interpolate into the portable `CREATE TABLE` DDL below on every dialect — a
// name matching this pattern has no quoting or injection surface.
const TABLE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Longest lock-table identifier — MySQL's 64-character table-name ceiling. */
const MAX_TABLE_NAME_LENGTH = 64;

/** Default lease before a held lock may be stolen by another claimant. */
const DEFAULT_LOCK_TTL_MS = 30_000;

/** Longest advisory-lock name — the lock table's `varchar(255)` key width. */
const MAX_LOCK_NAME_LENGTH = 255;

interface LockTable {
  readonly rows: ReturnType<typeof buildLockRows>;
  readonly createSql: string;
}

// `varchar(255)` primary key — not `text`, which MySQL rejects as a key without
// a prefix length. The lease is an ISO-8601 string compared lexicographically
// (== chronologically), so it needs no `bigint` and no per-engine timestamp
// type — the one axis that diverges across adapters.
function buildLockRows(table: string) {
  return defineTable(table, {
    name: columns.varchar(255).primaryKey(),
    owner: columns.varchar(255).notNull(),
    expiresAt: columns.varchar(64).notNull(),
  });
}

const lockTableCache = new Map<string, LockTable>();

// Resolves (and memoizes) the table model + portable DDL for a lock-table name.
// `create table if not exists`, `varchar(n)` primary key, and `varchar` columns
// all render identically on pg/neon/sqlite/libsql/mysql/mariadb.
function resolveLockTable(table: string): LockTable {
  const cached = lockTableCache.get(table);
  if (cached !== undefined) {
    return cached;
  }
  if (!TABLE_IDENTIFIER.test(table) || table.length > MAX_TABLE_NAME_LENGTH) {
    throw new OrmError(
      `Advisory lock table must be a plain identifier ` +
        `(letters, digits, "_"; ≤ ${MAX_TABLE_NAME_LENGTH} chars): "${table}"`,
      { code: "ORM_INVALID_QUERY", status: 400 },
    );
  }
  const resolved: LockTable = {
    rows: buildLockRows(table),
    createSql: `create table if not exists ${table} ` +
      `(name varchar(255) primary key, owner varchar(255) not null, ` +
      `expires_at varchar(64) not null)`,
  };
  lockTableCache.set(table, resolved);
  return resolved;
}

// Only the real engines back the lock table; the driverless `generic` dialect
// fails closed (it renders no `ON CONFLICT`/upsert form).
const LOCKABLE_DIALECTS: ReadonlySet<SqlDialect> = new Set([
  "postgres",
  "sqlite",
  "mysql",
]);

/** Options for {@link Database.tryAdvisoryLock}. */
export interface AdvisoryLockOptions {
  /**
   * Lease duration in milliseconds. A **live** holder keeps the lock; once the
   * lease lapses another claimant may steal it (covering a crashed holder).
   * Long runs should {@link AdvisoryLock.renew} within it. Default `30000`.
   */
  readonly ttlMs?: number;
  /**
   * Owner token stamped on the claim; only a matching token may
   * {@link AdvisoryLock.renew} or {@link AdvisoryLock.release} it. Defaults to a
   * random UUID. Supply a stable token to reclaim across process restarts.
   */
  readonly owner?: string;
  /**
   * Physical name of the lock-registry table. Defaults to
   * `"sisal_advisory_locks"`. Override it to place the lease rows under your own
   * naming convention (or schema) — Sisal never forces its default name into
   * your database. Must be a plain SQL identifier (letters, digits, `_`; ≤ 64
   * chars); all claimants sharing a lock must agree on the same table.
   */
  readonly table?: string;
}

/**
 * A held — or refused — advisory lock from {@link Database.tryAdvisoryLock}.
 * Always `await using` it so the lease is deleted on scope exit, including on an
 * early return or a throw. When {@link AdvisoryLock.acquired} is `false` another
 * live holder owns the name and nothing was claimed.
 */
export interface AdvisoryLock extends AsyncDisposable {
  /** Whether this claim won the lock. */
  readonly acquired: boolean;
  /** The owner token this claim used; `undefined` when not acquired. */
  readonly owner: string | undefined;
  /**
   * Extends the lease by `ttlMs` (default: the acquire ttl). Returns `true`
   * while still held, `false` if the lease was already lost or stolen — a
   * `false` means another runner may now hold the lock, so stop work. A no-op
   * returning `false` when not acquired.
   */
  renew(ttlMs?: number): Promise<boolean>;
  /**
   * Releases the lock, deleting only this owner's row (never a stealer's).
   * Idempotent; a no-op when not acquired or already released.
   */
  release(): Promise<void>;
}

function refusedLock(): AdvisoryLock {
  return {
    acquired: false,
    owner: undefined,
    renew: () => Promise.resolve(false),
    release: () => Promise.resolve(),
    [Symbol.asyncDispose]: () => Promise.resolve(),
  };
}

/**
 * Implements {@link Database.tryAdvisoryLock}. Non-blocking: claims the lease if
 * the name is free (or its lease expired) and returns immediately either way.
 */
export async function tryAcquireAdvisoryLock(
  db: Database,
  name: string,
  options: AdvisoryLockOptions = {},
): Promise<AdvisoryLock> {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new OrmError("Advisory lock name is required", {
      code: "ORM_INVALID_QUERY",
      status: 400,
    });
  }
  if (name.length > MAX_LOCK_NAME_LENGTH) {
    throw new OrmError(
      `Advisory lock name must be at most ${MAX_LOCK_NAME_LENGTH} characters`,
      { code: "ORM_INVALID_QUERY", status: 400 },
    );
  }
  if (!LOCKABLE_DIALECTS.has(db.dialect)) {
    throw new OrmError(
      `Advisory locks are not supported by the ${db.dialect} dialect`,
      { code: "ORM_DIALECT_UNSUPPORTED", status: 400 },
    );
  }

  const { rows, createSql } = resolveLockTable(
    options.table ?? DEFAULT_ADVISORY_LOCK_TABLE,
  );
  const ttlMs = options.ttlMs ?? DEFAULT_LOCK_TTL_MS;
  const owner = options.owner ?? crypto.randomUUID();
  const key = name.trim();

  await db.execute(raw(createSql));

  // Reap this name's row only when its lease has lapsed — a live holder is left
  // untouched, so we never steal an active lock. Then claim the name if absent;
  // the primary key makes the insert the atomic arbiter between racing
  // claimants (only one insert sets `owner`; a losing insert is a no-op that
  // leaves the incumbent's `owner` untouched).
  await db.delete(rows)
    .where(
      and(
        eq(rows.columns.name, key),
        lte(rows.columns.expiresAt, new Date().toISOString()),
      ),
    )
    .execute();

  await db.insert(rows)
    .values({ name: key, owner, expiresAt: leaseUntil(ttlMs) })
    .onConflictDoNothing()
    .execute();

  // Verify the claim by reading the row back and comparing `owner`, rather than
  // trusting the insert's affected-row count. The MySQL family renders the
  // no-op claim as `ON DUPLICATE KEY UPDATE`, whose affected-row count is 1 for
  // *both* a win and a conflicting no-op under the drivers' `CLIENT_FOUND_ROWS`
  // default — so a count-based signal double-grants the lock (SEC-008). An
  // owner-equality check is exact on every engine and independent of the
  // connection's found-rows flag, so mutual exclusion holds even if a caller
  // injects a pool that leaves found-rows enabled.
  const held = await db.select({ owner: rows.columns.owner })
    .from(rows)
    .where(eq(rows.columns.name, key))
    .limit(1)
    .execute();

  if (held[0]?.owner !== owner) {
    return refusedLock();
  }

  let released = false;

  const release = async (): Promise<void> => {
    if (released) {
      return;
    }
    released = true;
    await db.delete(rows)
      .where(
        and(eq(rows.columns.name, key), eq(rows.columns.owner, owner)),
      )
      .execute();
  };

  const renew = async (renewTtlMs: number = ttlMs): Promise<boolean> => {
    if (released) {
      return false;
    }
    const updated = await db.update(rows)
      .set({ expiresAt: leaseUntil(renewTtlMs) })
      .where(
        and(eq(rows.columns.name, key), eq(rows.columns.owner, owner)),
      )
      .execute();
    return (updated.rowCount ?? 0) >= 1;
  };

  return {
    acquired: true,
    owner,
    renew,
    release,
    [Symbol.asyncDispose]: release,
  };
}

function leaseUntil(ttlMs: number): string {
  return new Date(Date.now() + Math.max(0, ttlMs)).toISOString();
}
