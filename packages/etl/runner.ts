/**
 * The ETL runtime tier (v0.10 T16–T19): {@link run} executes exactly one
 * window of a job and exits — the unit an external scheduler (cron, systemd
 * timer, CI) invokes — and {@link backfill} / {@link replay} /
 * {@link status} fan out from it (historical re-runs that never move the
 * watermark, and the read-only report). The whole v0.10 runtime is: acquire the portable
 * advisory lock → read the checkpoint → compute the next half-open window →
 * send the generated rollup SQL → advance the watermark **atomically with**
 * the load — the two v0.9-tested substrate invariants
 * (`db.tryAdvisoryLock`'s lock-row lease and `etlCheckpoint().advance`'s
 * single `db.batch`), consumed here rather than rebuilt.
 *
 * `run()` owns its transaction boundary: the rollup statement and the
 * watermark upsert commit together inside the checkpoint's `db.batch`, so it
 * must not be composed into a caller's transaction. Concurrency is
 * serialized by the lock — a second concurrent runner observes `locked` and
 * exits without touching the data.
 *
 * This is the `@sisal/etl` → `@sisal/orm` runtime edge recorded in
 * `docs/architecture.md`; the job model and SQL compilation tiers stay
 * `@sisal/core`-only.
 *
 * @module
 */

import { etlCheckpoint } from "@sisal/orm";
import type {
  AdvisoryLock,
  AdvisoryLockOptions,
  Checkpoint,
  CheckpointState,
  Database,
} from "@sisal/orm";
import { assertJobSupported } from "./capability.ts";
import type { EtlJob } from "./job.ts";
import { rollup } from "./rollup.ts";
import { nextWindow, windowAt, windowsInRange } from "./window.ts";
import type { EtlRange, EtlWindow } from "./window.ts";

/** Prefix of the advisory-lock name guarding a job's runs. */
const LOCK_PREFIX = "sisal:etl:";

/** Options for {@link run}. */
export interface EtlRunOptions {
  /**
   * The reference clock (defaults to `new Date()`); a window is run only when
   * its bucket has fully closed (`until <= now`). Inject it for deterministic
   * tests.
   */
  readonly now?: Date;
  /**
   * Physical checkpoint-table override, forwarded to the checkpoint substrate
   * (defaults to `sisal_etl_checkpoints`).
   */
  readonly checkpointTable?: string;
  /**
   * Advisory-lock options (TTL, owner token, table override), forwarded to
   * `db.tryAdvisoryLock`.
   */
  readonly lock?: AdvisoryLockOptions;
}

/**
 * What one {@link run} invocation did. A non-run is a normal outcome, not an
 * error: `locked` means another runner holds the job's lock; `up-to-date`
 * means the next bucket has not closed yet.
 */
export type EtlRunOutcome =
  | {
    /** A window was executed and committed. */
    readonly ran: true;
    /** The half-open window that was folded. */
    readonly window: EtlWindow;
  }
  | {
    /** No window was executed. */
    readonly ran: false;
    /** Why the run stepped aside. */
    readonly reason: "locked" | "up-to-date";
  };

/**
 * Runs the next window of `job` on `db`, once:
 *
 * 1. acquires the job's advisory lock (`sisal:etl:<name>`) — if another
 *    runner holds it, returns `{ ran: false, reason: "locked" }`;
 * 2. reads the job's checkpoint and computes the next half-open window from
 *    the watermark (or the job's `start` on a fresh job) — if the next
 *    bucket has not closed yet, returns `{ ran: false, reason: "up-to-date" }`;
 * 3. sends the generated rollup and advances the watermark to `until` in one
 *    atomic `db.batch`, then releases the lock.
 *
 * Idempotent by construction: the rollup upserts on the grain key, and a
 * crash before the batch commits leaves the watermark untouched, so the next
 * run repeats the same window. Propagates the substrate's typed errors
 * (`ETL_MISSING_START`, `ORM_DIALECT_UNSUPPORTED` on the `generic` dialect,
 * `ETL_INVALID_JOB` from definition).
 */
export async function run(
  db: Database,
  job: EtlJob,
  options: EtlRunOptions = {},
): Promise<EtlRunOutcome> {
  assertJobSupported(job, db.dialectIdentity);
  const lock = await acquireJobLock(db, job, options.lock);
  if (!lock.acquired) {
    return { ran: false, reason: "locked" };
  }
  try {
    const checkpoint = jobCheckpoint(db, job, options.checkpointTable);
    const window = nextWindow({
      watermark: await checkpoint.read(),
      ...(job.start === undefined ? {} : { start: job.start }),
      grain: job.grain,
      now: options.now ?? new Date(),
    });
    if (window === null) {
      return { ran: false, reason: "up-to-date" };
    }
    await checkpoint.advance(window.until, [rollup(job, window)]);
    return { ran: true, window };
  } finally {
    await lock.release();
  }
}

function acquireJobLock(
  db: Database,
  job: EtlJob,
  options: AdvisoryLockOptions | undefined,
): Promise<AdvisoryLock> {
  return db.tryAdvisoryLock(`${LOCK_PREFIX}${job.name}`, options);
}

function jobCheckpoint(
  db: Database,
  job: EtlJob,
  table: string | undefined,
): Checkpoint {
  return etlCheckpoint(db, job.name, table === undefined ? {} : { table });
}

/** Options for {@link backfill} and {@link replay}. */
export interface EtlReplayOptions {
  /**
   * Physical checkpoint-table override, forwarded to the checkpoint substrate
   * (defaults to `sisal_etl_checkpoints`).
   */
  readonly checkpointTable?: string;
  /**
   * Advisory-lock options (TTL, owner token, table override), forwarded to
   * `db.tryAdvisoryLock`.
   */
  readonly lock?: AdvisoryLockOptions;
  /**
   * Bypass the `pruned_before` retention-horizon refusal — set it only when
   * the source rows for the window have been restored (or re-derived from an
   * archive). Forwarded to the checkpoint substrate's `assertReplayable`,
   * which warns loudly when the bypass fires.
   */
  readonly unsafeAllowPrunedReplay?: boolean;
}

/** What one {@link backfill} invocation did. */
export type EtlBackfillOutcome =
  | {
    /** Every window of the range was executed. */
    readonly ran: true;
    /** The successive windows that were folded, in order. */
    readonly windows: readonly EtlWindow[];
  }
  | {
    /** Another runner holds the job's lock; nothing was executed. */
    readonly ran: false;
    /** Why the backfill stepped aside. */
    readonly reason: "locked";
  };

/** What one {@link replay} invocation did. */
export type EtlReplayOutcome =
  | {
    /** The window was re-executed. */
    readonly ran: true;
    /** The half-open window that was folded. */
    readonly window: EtlWindow;
  }
  | {
    /** Another runner holds the job's lock; nothing was executed. */
    readonly ran: false;
    /** Why the replay stepped aside. */
    readonly reason: "locked";
  };

/**
 * Deterministically re-runs an explicit historical range as successive
 * one-grain windows — the same generated SQL and idempotent upsert as
 * {@link run}, with **no dependence on wall-clock now**. Both range bounds
 * must be grain-aligned (`ETL_INVALID_WINDOW` otherwise), so the windows
 * partition the range exactly.
 *
 * A backfill rewrites history; it never advances the job's checkpoint — the
 * regular `run()` cadence is unaffected, and a backfill on a fresh job does
 * not establish a watermark. It is serialized by the job's advisory lock and
 * refuses a range that begins behind the `pruned_before` retention horizon
 * (`ORM_REPLAY_PRUNED`; see {@link EtlReplayOptions.unsafeAllowPrunedReplay}).
 * Windows execute one statement at a time, in order — a crash mid-range is
 * safe to re-run.
 */
export async function backfill(
  db: Database,
  job: EtlJob,
  range: EtlRange,
  options: EtlReplayOptions = {},
): Promise<EtlBackfillOutcome> {
  assertJobSupported(job, db.dialectIdentity);
  const windows = windowsInRange(range, job.grain);
  const lock = await acquireJobLock(db, job, options.lock);
  if (!lock.acquired) {
    return { ran: false, reason: "locked" };
  }
  try {
    const checkpoint = jobCheckpoint(db, job, options.checkpointTable);
    await checkpoint.assertReplayable(range.from, {
      unsafeAllowPrunedReplay: options.unsafeAllowPrunedReplay === true,
    });
    for (const window of windows) {
      await db.execute(rollup(job, window));
    }
    return { ran: true, windows };
  } finally {
    await lock.release();
  }
}

/**
 * Idempotently re-runs the single one-grain window starting at the
 * grain-aligned instant `from` — the upsert overwrites the window's rollup
 * rows in place. Refuses a window behind the job's `pruned_before` retention
 * horizon with the v0.9 typed `ORM_REPLAY_PRUNED` error (replaying over
 * pruned source rows would overwrite a good rollup with missing data);
 * {@link EtlReplayOptions.unsafeAllowPrunedReplay} is the loud, deliberate
 * override for a restored source. Serialized by the job's advisory lock;
 * never advances the checkpoint.
 */
export async function replay(
  db: Database,
  job: EtlJob,
  from: string,
  options: EtlReplayOptions = {},
): Promise<EtlReplayOutcome> {
  assertJobSupported(job, db.dialectIdentity);
  const window = windowAt(from, job.grain);
  const lock = await acquireJobLock(db, job, options.lock);
  if (!lock.acquired) {
    return { ran: false, reason: "locked" };
  }
  try {
    const checkpoint = jobCheckpoint(db, job, options.checkpointTable);
    await checkpoint.assertReplayable(window.from, {
      unsafeAllowPrunedReplay: options.unsafeAllowPrunedReplay === true,
    });
    await db.execute(rollup(job, window));
    return { ran: true, window };
  } finally {
    await lock.release();
  }
}

/** Options for {@link status}. */
export interface EtlStatusOptions {
  /** The reference clock for the next-window computation. */
  readonly now?: Date;
  /** Physical checkpoint-table override. */
  readonly checkpointTable?: string;
}

/** The read-only job report returned by {@link status}. */
export interface EtlStatus {
  /** The stable job id. */
  readonly job: string;
  /**
   * The full checkpoint row — watermark, retention horizon, last advance
   * time — or `null` when the job has never run.
   */
  readonly checkpoint: CheckpointState | null;
  /**
   * The window the next `run()` would fold, or `null` when the job is up to
   * date — or has no checkpoint and no declared `start`.
   */
  readonly next: EtlWindow | null;
}

/**
 * Reports where `job` stands — checkpoint position, retention horizon,
 * last-run state, and the window the next {@link run} would fold. Read-only:
 * takes no lock and writes nothing, so it is safe to call from dashboards
 * and health checks while a runner is live.
 */
export async function status(
  db: Database,
  job: EtlJob,
  options: EtlStatusOptions = {},
): Promise<EtlStatus> {
  const checkpoint = jobCheckpoint(db, job, options.checkpointTable);
  const state = await checkpoint.readState();
  const marker = state?.windowEnd ?? job.start;
  const next = marker === undefined ? null : nextWindow({
    watermark: state?.windowEnd ?? null,
    ...(job.start === undefined ? {} : { start: job.start }),
    grain: job.grain,
    now: options.now ?? new Date(),
  });
  return { job: job.name, checkpoint: state, next };
}
