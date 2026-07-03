/**
 * Window computation for the ETL runner (v0.10 T15): given the last committed
 * watermark (or a job's declared start), compute the next **half-open** window
 * `[from, until)` — one grain wide, aligned to UTC bucket edges, and never
 * extending past `now`, so a run only ever folds **complete** buckets and a
 * re-run of the same window can never double-count a row (`>= from` and
 * `< until` partition the timeline exactly).
 *
 * All math is UTC calendar arithmetic over ISO-8601 markers — the same
 * convention the checkpoint substrate stores (opaque TEXT, lexicographic ==
 * chronological), and the same truncation `dateTrunc` applies in the
 * database, so the runner's edges and the database's buckets agree.
 *
 * @module
 */

import { OrmError } from "@sisal/core";
import type { EtlGrain } from "./job.ts";

/**
 * A half-open ETL window `[from, until)` as ISO-8601 UTC instants. `from` is
 * inclusive, `until` exclusive — adjacent windows share an edge without
 * overlapping.
 */
export interface EtlWindow {
  /** Inclusive lower bound (the resume point). */
  readonly from: string;
  /** Exclusive upper bound (the next watermark). */
  readonly until: string;
}

/** Inputs to {@link nextWindow}. */
export interface NextWindowParts {
  /**
   * The checkpoint's committed `window_end`, or `null` for a fresh job (the
   * job's `start` is used instead).
   */
  readonly watermark: string | null;
  /** The job's declared grain-aligned start, for a fresh job. */
  readonly start?: string;
  /** Bucket width of the window. */
  readonly grain: EtlGrain;
  /** The reference clock; a window is only produced when `until <= now`. */
  readonly now: Date;
}

function parseMarker(value: string, label: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new OrmError(
      `ETL ${label} must be an ISO-8601 instant, got "${value}"`,
      { code: "ETL_INVALID_WINDOW", status: 400, details: { [label]: value } },
    );
  }
  return parsed;
}

function unknownGrain(grain: string): OrmError {
  return new OrmError(`Unknown ETL grain "${grain}"`, {
    code: "ETL_INVALID_WINDOW",
    status: 400,
    details: { grain },
  });
}

/**
 * Floors `instant` to its UTC `grain` edge — the runner-side mirror of the
 * database-side `dateTrunc(grain, ...)`, zeroing every finer field.
 */
export function truncateToGrain(instant: Date, grain: EtlGrain): Date {
  const y = instant.getUTCFullYear();
  const mo = instant.getUTCMonth();
  const d = instant.getUTCDate();
  const h = instant.getUTCHours();
  const mi = instant.getUTCMinutes();
  const s = instant.getUTCSeconds();
  switch (grain) {
    case "year":
      return new Date(Date.UTC(y, 0, 1));
    case "month":
      return new Date(Date.UTC(y, mo, 1));
    case "day":
      return new Date(Date.UTC(y, mo, d));
    case "hour":
      return new Date(Date.UTC(y, mo, d, h));
    case "minute":
      return new Date(Date.UTC(y, mo, d, h, mi));
    case "second":
      return new Date(Date.UTC(y, mo, d, h, mi, s));
    default:
      throw unknownGrain(grain);
  }
}

/**
 * Advances `instant` by exactly one `grain` in UTC calendar arithmetic
 * (`month`/`year` are calendar units, not a fixed number of seconds).
 */
export function addGrain(instant: Date, grain: EtlGrain): Date {
  const next = new Date(instant.getTime());
  switch (grain) {
    case "year":
      next.setUTCFullYear(next.getUTCFullYear() + 1);
      return next;
    case "month":
      next.setUTCMonth(next.getUTCMonth() + 1);
      return next;
    case "day":
      next.setUTCDate(next.getUTCDate() + 1);
      return next;
    case "hour":
      return new Date(next.getTime() + 3_600_000);
    case "minute":
      return new Date(next.getTime() + 60_000);
    case "second":
      return new Date(next.getTime() + 1_000);
    default:
      throw unknownGrain(grain);
  }
}

/**
 * An explicit historical range for `backfill` — half-open `[from, until)`,
 * both bounds **grain-aligned** ISO instants.
 */
export interface EtlRange {
  /** Inclusive, grain-aligned lower bound. */
  readonly from: string;
  /** Exclusive, grain-aligned upper bound. */
  readonly until: string;
}

function parseAligned(value: string, grain: EtlGrain, label: string): Date {
  const parsed = parseMarker(value, label);
  if (truncateToGrain(parsed, grain).getTime() !== parsed.getTime()) {
    throw new OrmError(
      `ETL ${label} must lie on a "${grain}" edge (UTC), got "${value}" — ` +
        `an unaligned bound would cover partial buckets`,
      { code: "ETL_INVALID_WINDOW", status: 400, details: { [label]: value } },
    );
  }
  return parsed;
}

/**
 * The one-grain window starting at the **grain-aligned** instant `from` —
 * `[from, from + grain)`. The shape `replay` re-runs. Throws
 * `ETL_INVALID_WINDOW` for an unparsable or unaligned `from`.
 */
export function windowAt(from: string, grain: EtlGrain): EtlWindow {
  const start = parseAligned(from, grain, "replay window (from)");
  return {
    from: start.toISOString(),
    until: addGrain(start, grain).toISOString(),
  };
}

/**
 * Enumerates the successive one-grain windows covering the half-open range
 * `[range.from, range.until)` — the deterministic `backfill` walk, with no
 * dependence on wall-clock now. Both bounds must be grain-aligned and
 * `from < until` (throws `ETL_INVALID_WINDOW` otherwise), so the windows
 * partition the range exactly: each row of the range falls in exactly one
 * window.
 */
export function windowsInRange(
  range: EtlRange,
  grain: EtlGrain,
): EtlWindow[] {
  const from = parseAligned(range.from, grain, "backfill range (from)");
  const until = parseAligned(range.until, grain, "backfill range (until)");
  if (from.getTime() >= until.getTime()) {
    throw new OrmError(
      `ETL backfill range must be half-open with from < until, got ` +
        `[${range.from}, ${range.until})`,
      { code: "ETL_INVALID_WINDOW", status: 400, details: { ...range } },
    );
  }
  const windows: EtlWindow[] = [];
  for (
    let edge = from;
    edge.getTime() < until.getTime();
    edge = addGrain(edge, grain)
  ) {
    windows.push({
      from: edge.toISOString(),
      until: addGrain(edge, grain).toISOString(),
    });
  }
  return windows;
}

/**
 * Computes the next half-open window `[from, until)`, or `null` when the job
 * is **up to date** (the next bucket has not closed yet — `until` would
 * exceed `now`).
 *
 * An aligned watermark resumes exactly there and folds one whole bucket. A
 * hand-advanced **unaligned** watermark is floored to its bucket edge, so the
 * next window refolds the **whole containing bucket** — never a partial tail:
 * because the upsert *overwrites* the bucket row, a window starting mid-bucket
 * would silently replace the bucket's aggregates with an undercount computed
 * from only the tail rows. Refolding from the edge re-scans rows the previous
 * fold already counted, which the grain-keyed upsert makes idempotent. Throws
 * `ETL_MISSING_START` when there is neither a watermark nor a start, and
 * `ETL_INVALID_WINDOW` for an unparsable marker.
 */
export function nextWindow(parts: NextWindowParts): EtlWindow | null {
  const marker = parts.watermark ?? parts.start;
  if (marker === undefined) {
    throw new OrmError(
      "ETL job has no checkpoint and no start — declare `start` on the job " +
        "(a grain-aligned ISO instant) or backfill an explicit range",
      { code: "ETL_MISSING_START", status: 400 },
    );
  }
  const marked = parseMarker(
    marker,
    parts.watermark === null ? "start" : "watermark",
  );
  // Floor to the bucket edge: a no-op for an aligned marker; for an unaligned
  // one this refolds the whole bucket the marker landed in (see above).
  const from = truncateToGrain(marked, parts.grain);
  const until = addGrain(from, parts.grain);
  if (until.getTime() > parts.now.getTime()) {
    return null;
  }
  return { from: from.toISOString(), until: until.toISOString() };
}
