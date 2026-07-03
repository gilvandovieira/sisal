/**
 * The ETL checkpoint / watermark substrate (v0.9 T12, v0.6 A3/A4 / contract 09).
 * A small typed system table, `sisal_etl_checkpoints`, records the last
 * committed window per job so a future `@sisal/etl` runner can **resume** after a
 * crash and **backfill** historical ranges without double-counting.
 *
 * The value this file guarantees is the **atomic load+advance invariant**: the
 * idempotent load and the watermark advance commit **together** (one
 * `db.batch`), so a crash can never leave the watermark ahead of the data it
 * claims to cover. Watermarks are stored as **opaque TEXT** (ISO-8601 by
 * convention, but the caller owns the meaning — a timestamp or a monotonic id),
 * which keeps the checkpoint uniform across every engine with no per-adapter
 * timestamp-decode divergence.
 *
 * The mirror invariant (T14) is **replay-vs-retention**: `prune(before, deletes)`
 * advances the per-job `pruned_before` **retention horizon** atomically with the
 * source delete (so the horizon never lags the delete), and
 * `assertReplayable(from)` refuses a replay whose window begins before the
 * horizon — replaying over pruned source rows would silently overwrite a good
 * rollup with missing data. The refusal carries a typed error and an explicit
 * `unsafeAllowPrunedReplay` override, mirroring `.unsafeAllowAllRows()`.
 *
 * Part of the `@sisal/orm` core; the `@sisal/etl`-managed table lives here as the
 * v0.10 substrate (no `etl → migrate` edge — see contract 09).
 *
 * @module
 */

import { columns, defineTable, eq, excluded, OrmError, raw } from "@sisal/core";
import type { BatchStatement, Database } from "./database.ts";

/** Default physical name of the checkpoint table. */
const DEFAULT_CHECKPOINT_TABLE = "sisal_etl_checkpoints";

// Same policy as the advisory-lock table: a plain, unqualified identifier,
// validated (not quoted) so it is safe to interpolate into the portable
// `CREATE TABLE` DDL on every dialect.
const TABLE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_TABLE_NAME_LENGTH = 64;
const MAX_JOB_LENGTH = 255;
const MAX_WATERMARK_LENGTH = 64;

// `varchar` primary key + `varchar` watermarks — MySQL rejects a `text` key
// without a prefix length, and TEXT watermarks compared/stored as strings avoid
// the per-engine timestamp-decode divergence (ISO-8601 sorts lexicographically).
function buildCheckpointRows(table: string) {
  return defineTable(table, {
    job: columns.varchar(MAX_JOB_LENGTH).primaryKey(),
    windowEnd: columns.varchar(MAX_WATERMARK_LENGTH).notNull(),
    // Insert-optional — the retention horizon, owned by `prune`. A plain
    // `advance` never touches it (omitted insert → NULL), so `read`/`advance` and
    // `prune` update disjoint columns and never clobber each other.
    prunedBefore: columns.varchar(MAX_WATERMARK_LENGTH).optional(),
    updatedAt: columns.varchar(MAX_WATERMARK_LENGTH).notNull(),
  });
}

interface CheckpointTable {
  readonly rows: ReturnType<typeof buildCheckpointRows>;
  readonly createSql: string;
}

const checkpointTableCache = new Map<string, CheckpointTable>();

function resolveCheckpointTable(table: string): CheckpointTable {
  const cached = checkpointTableCache.get(table);
  if (cached !== undefined) {
    return cached;
  }
  if (!TABLE_IDENTIFIER.test(table) || table.length > MAX_TABLE_NAME_LENGTH) {
    throw new OrmError(
      `Checkpoint table must be a plain identifier ` +
        `(letters, digits, "_"; ≤ ${MAX_TABLE_NAME_LENGTH} chars): "${table}"`,
      { code: "ORM_INVALID_QUERY", status: 400 },
    );
  }
  const resolved: CheckpointTable = {
    rows: buildCheckpointRows(table),
    createSql: `create table if not exists ${table} ` +
      `(job varchar(${MAX_JOB_LENGTH}) primary key, ` +
      `window_end varchar(${MAX_WATERMARK_LENGTH}) not null, ` +
      `pruned_before varchar(${MAX_WATERMARK_LENGTH}), ` +
      `updated_at varchar(${MAX_WATERMARK_LENGTH}) not null)`,
  };
  checkpointTableCache.set(table, resolved);
  return resolved;
}

/**
 * The full checkpoint row for a job — the A3 contract shape (`window_end`,
 * `pruned_before`, `updated_at`). Returned by {@link Checkpoint.readState}.
 */
export interface CheckpointState {
  /** Exclusive end of the last committed window (the resume point). */
  readonly windowEnd: string;
  /**
   * The retention **replay horizon** — the exclusive upper bound of source rows
   * a prune has removed. `null` until the first prune (the T14 concern).
   */
  readonly prunedBefore: string | null;
  /** When the checkpoint row was last advanced (ISO-8601). */
  readonly updatedAt: string;
}

// Validates a watermark/horizon marker: a non-empty string within the column
// width. Shared by `advance`, `prune`, and `assertReplayable`.
function assertMarker(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new OrmError(`Checkpoint ${label} is required`, {
      code: "ORM_INVALID_QUERY",
      status: 400,
    });
  }
  if (value.length > MAX_WATERMARK_LENGTH) {
    throw new OrmError(
      `Checkpoint ${label} must be at most ${MAX_WATERMARK_LENGTH} characters`,
      { code: "ORM_INVALID_QUERY", status: 400 },
    );
  }
}

/** Options for {@link Checkpoint.assertReplayable}. */
export interface ReplayGuardOptions {
  /**
   * Bypass the retention-horizon refusal. Set this only when re-deriving from a
   * different or restored source (backfilling from an archive, recomputing a
   * derived source) — it is the deliberate opt-out mirroring
   * `.unsafeAllowAllRows()`. Off by default; the refusal is loud when bypassed.
   */
  readonly unsafeAllowPrunedReplay?: boolean;
}

/** Options for {@link etlCheckpoint}. */
export interface CheckpointOptions {
  /**
   * Physical name of the checkpoint table. Defaults to `"sisal_etl_checkpoints"`.
   * Override it to place the rows under your own naming convention — Sisal never
   * forces its default name into your database. Must be a plain SQL identifier
   * (letters, digits, `_`; ≤ 64 chars).
   */
  readonly table?: string;
}

/**
 * A checkpoint handle bound to one `job`. Reads the last committed watermark and
 * advances it atomically with an idempotent load. Create it with
 * {@link etlCheckpoint}.
 */
export interface Checkpoint {
  /** The stable job id this checkpoint tracks. */
  readonly job: string;
  /**
   * Reads the last committed `window_end` watermark, or `null` when the job has
   * no checkpoint yet (a fresh run should start from the beginning).
   */
  read(): Promise<string | null>;
  /**
   * Reads the full checkpoint row — `window_end`, the `pruned_before` retention
   * horizon, and `updated_at` — or `null` when the job has no checkpoint yet.
   * {@link Checkpoint.read} is the `window_end`-only shortcut.
   */
  readState(): Promise<CheckpointState | null>;
  /**
   * Advances the watermark to `until` **atomically with** `load`: the load
   * statements and the `window_end` upsert run in one `db.batch`, so they commit
   * together and roll back together. A crash therefore never advances the
   * watermark past data that was not written. `load` must not read a prior
   * statement's result (the `db.batch` constraint); it may be empty to record an
   * empty window. `until` is an opaque marker string (≤ 64 chars).
   */
  advance(until: string, load?: readonly BatchStatement[]): Promise<void>;
  /**
   * Advances the `pruned_before` **retention horizon** to `before` **atomically
   * with** `deletes` — the source-pruning statements and the horizon upsert run
   * in one `db.batch`, so the horizon never lags the delete (the mirror of
   * {@link Checkpoint.advance}). Prune only what has already been consolidated
   * (`before <= window_end`); a later {@link Checkpoint.assertReplayable} refuses
   * windows behind the horizon. `deletes` may be empty to only raise the horizon.
   */
  prune(before: string, deletes?: readonly BatchStatement[]): Promise<void>;
  /**
   * Refuses — throws `ORM_REPLAY_PRUNED` — when the replay window beginning at
   * `from` starts **before** the retention horizon (`from < pruned_before`),
   * because its source rows were pruned and replaying would overwrite the rollup
   * with missing data. A no-op when the horizon is unset or `from >=
   * pruned_before`. Pass `{ unsafeAllowPrunedReplay: true }` to override for a
   * restored/alternate source.
   */
  assertReplayable(from: string, options?: ReplayGuardOptions): Promise<void>;
}

/**
 * Creates a {@link Checkpoint} for `job` on `db` — the portable watermark
 * substrate a future ETL runner resumes from. Reads/advances the
 * `sisal_etl_checkpoints` table (override the name with `options.table`), which
 * is created on first use. Throws `ORM_INVALID_QUERY` for an empty/oversized job
 * id or an unsafe table name.
 *
 * ```ts
 * const cp = etlCheckpoint(db, "hourly-rollup");
 * const from = await cp.read(); // resume point, or null on a fresh job
 * await cp.advance(until, [
 *   db.insert(rollup).select(windowQuery)
 *     .onConflictDoUpdate({ target, set }), // idempotent load
 * ]);
 * ```
 */
export function etlCheckpoint(
  db: Database,
  job: string,
  options: CheckpointOptions = {},
): Checkpoint {
  if (typeof job !== "string" || job.trim().length === 0) {
    throw new OrmError("Checkpoint job id is required", {
      code: "ORM_INVALID_QUERY",
      status: 400,
    });
  }
  if (job.length > MAX_JOB_LENGTH) {
    throw new OrmError(
      `Checkpoint job id must be at most ${MAX_JOB_LENGTH} characters`,
      { code: "ORM_INVALID_QUERY", status: 400 },
    );
  }
  // Fail closed on the driverless `generic` dialect (as the advisory lock does):
  // the upsert/`excluded()` forms the checkpoint relies on are not rendered
  // there, so there is no correct behavior to offer.
  if (db.dialect === "generic") {
    throw new OrmError(
      "ETL checkpoints are not supported by the generic dialect",
      { code: "ORM_DIALECT_UNSUPPORTED", status: 400 },
    );
  }
  const jobId = job.trim();
  const { rows, createSql } = resolveCheckpointTable(
    options.table ?? DEFAULT_CHECKPOINT_TABLE,
  );

  const ensureTable = (): Promise<unknown> => db.execute(raw(createSql));

  const read = async (): Promise<string | null> => {
    await ensureTable();
    const found = await db.select({ windowEnd: rows.columns.windowEnd })
      .from(rows)
      .where(eq(rows.columns.job, jobId))
      .execute();
    return found[0]?.windowEnd ?? null;
  };

  const readState = async (): Promise<CheckpointState | null> => {
    await ensureTable();
    const found = await db.select({
      windowEnd: rows.columns.windowEnd,
      prunedBefore: rows.columns.prunedBefore,
      updatedAt: rows.columns.updatedAt,
    })
      .from(rows)
      .where(eq(rows.columns.job, jobId))
      .execute();
    const row = found[0];
    return row === undefined ? null : {
      windowEnd: row.windowEnd,
      prunedBefore: row.prunedBefore,
      updatedAt: row.updatedAt,
    };
  };

  const advance = async (
    until: string,
    load: readonly BatchStatement[] = [],
  ): Promise<void> => {
    assertMarker(until, "watermark (until)");
    await ensureTable();
    // The watermark upsert runs LAST in the same atomic batch as the load, so
    // `window_end` only moves if every load statement committed too.
    const watermark = db.insert(rows)
      .values({
        job: jobId,
        windowEnd: until,
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: rows.columns.job,
        set: {
          windowEnd: excluded(rows.columns.windowEnd),
          updatedAt: excluded(rows.columns.updatedAt),
        },
      });
    await db.batch([...load, watermark]);
  };

  const prune = async (
    before: string,
    deletes: readonly BatchStatement[] = [],
  ): Promise<void> => {
    assertMarker(before, "prune horizon (before)");
    await ensureTable();
    // The horizon upsert runs FIRST in the batch, then the source deletes — the
    // mirror-opposite of `advance` (which puts its watermark last). If `db.batch`
    // is atomic the order is immaterial; under the non-atomic fallback a crash
    // between the two statements must leave the horizon *ahead* of the delete,
    // never behind: a raised horizon over rows still present only makes
    // `assertReplayable` conservatively refuse a replay (and a re-run prunes the
    // rows), whereas a delete that outran the horizon would let a replay
    // overwrite the rollup with missing data. The upsert updates only
    // `pruned_before`/`updated_at`; `window_end` is preserved on conflict (and
    // seeded to `before` only if no checkpoint exists yet).
    const horizon = db.insert(rows)
      .values({
        job: jobId,
        windowEnd: before,
        prunedBefore: before,
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: rows.columns.job,
        set: {
          prunedBefore: excluded(rows.columns.prunedBefore),
          updatedAt: excluded(rows.columns.updatedAt),
        },
      });
    await db.batch([horizon, ...deletes]);
  };

  const assertReplayable = async (
    from: string,
    options: ReplayGuardOptions = {},
  ): Promise<void> => {
    assertMarker(from, "replay window (from)");
    const horizon = (await readState())?.prunedBefore ?? null;
    // TEXT markers compare lexicographically (== chronologically for ISO-8601);
    // `from >= horizon` is replayable, `from < horizon` is not.
    const behindHorizon = horizon !== null && from < horizon;
    if (!behindHorizon) {
      return;
    }
    if (options.unsafeAllowPrunedReplay === true) {
      // The override is deliberate, but a replay over pruned source rows is
      // dangerous enough to never pass silently — warn so it is visible in logs
      // and audits (the finding behind SEC-012).
      console.warn(
        `[sisal] unsafeAllowPrunedReplay: replaying window from=${from} behind ` +
          `the retention horizon pruned_before=${horizon} for job "${jobId}" — ` +
          `the rollup will be re-derived from the current source, which must be ` +
          `restored/complete for that window`,
      );
      return;
    }
    throw new OrmError(
      `Refusing to replay window from=${from} behind the retention horizon ` +
        `pruned_before=${horizon} for job "${jobId}" without an explicit ` +
        `unsafeAllowPrunedReplay — its source rows were pruned, so the rollup ` +
        `would be overwritten with missing data`,
      {
        code: "ORM_REPLAY_PRUNED",
        status: 409,
        details: { job: jobId, from, prunedBefore: horizon },
      },
    );
  };

  return { job: jobId, read, readState, advance, prune, assertReplayable };
}
