/**
 * Pure latency-measurement utilities for Sisal's real-database performance
 * probes.
 *
 * This module has **no** database, network, or FFI dependency — it is only
 * timing math and table formatting, so it stays deterministic, testable, and
 * reusable across perf entrypoints (the standalone benchmark and its guard
 * test). The database-touching paths live in the sibling probe modules.
 *
 * @module
 */

/** A single measured path: a stable id, a human label, and the op to time. */
export interface LatencyPath {
  /** Machine-stable identifier used to look a path up in results. */
  readonly id: string;
  /** Human-facing label rendered in the results table. */
  readonly label: string;
  /** Optional grouping tag, e.g. `"sisal"`, `"driver"`, `"reference"`. */
  readonly kind?: string;
  /** The operation to time; awaited once per iteration. */
  readonly fn: () => Promise<unknown>;
}

/** Summary statistics for one measured path. All durations are milliseconds. */
export interface LatencySummary {
  readonly id: string;
  readonly label: string;
  readonly kind?: string;
  readonly iters: number;
  readonly min: number;
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
  readonly mean: number;
}

/** Iteration and warm-up counts for {@link measure}. */
export interface MeasureOptions {
  /** Timed iterations. */
  readonly iters?: number;
  /** Untimed warm-up iterations run before timing begins. */
  readonly warmup?: number;
}

const DEFAULT_ITERS = 200;
const DEFAULT_WARMUP = 25;

/**
 * Nearest-rank percentile (`p` in `0..100`) of an unsorted millisecond sample.
 *
 * Returns `NaN` for an empty sample. The input is not mutated.
 */
export function percentile(samplesMs: readonly number[], p: number): number {
  if (samplesMs.length === 0) return Number.NaN;
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

/**
 * Time a single {@link LatencyPath} sequentially and summarize it.
 *
 * Warm-up iterations run first (to prime connections, JIT, and OS buffers) and
 * are excluded from the reported statistics. Iterations are awaited one at a
 * time — never overlapped — because the pathology this suite guards against
 * (TCP Nagle × delayed-ACK on the extended protocol) is a per-round-trip timer
 * that concurrency would mask.
 */
export async function measure(
  path: LatencyPath,
  options: MeasureOptions = {},
): Promise<LatencySummary> {
  const iters = options.iters ?? DEFAULT_ITERS;
  const warmup = options.warmup ?? DEFAULT_WARMUP;

  for (let i = 0; i < warmup; i++) {
    await path.fn();
  }

  const samples = new Array<number>(iters);
  let min = Number.POSITIVE_INFINITY;
  let total = 0;
  for (let i = 0; i < iters; i++) {
    const start = performance.now();
    await path.fn();
    const elapsed = performance.now() - start;
    samples[i] = elapsed;
    total += elapsed;
    if (elapsed < min) min = elapsed;
  }

  return {
    id: path.id,
    label: path.label,
    kind: path.kind,
    iters,
    min: iters === 0 ? Number.NaN : min,
    p50: percentile(samples, 50),
    p90: percentile(samples, 90),
    p99: percentile(samples, 99),
    mean: iters === 0 ? Number.NaN : total / iters,
  };
}

const ms = (value: number): string =>
  Number.isNaN(value) ? "—" : value.toFixed(2);

/**
 * Render a fixed-width results table, sorted fastest-p50 first, with a final
 * "vs fastest" column expressing each path's p50 as a multiple of the quickest.
 */
export function formatResultsTable(
  results: readonly LatencySummary[],
): string {
  if (results.length === 0) return "(no results)";

  const ordered = [...results].sort((a, b) => a.p50 - b.p50);
  const fastest = ordered[0].p50;

  const rows = ordered.map((r) => ({
    label: r.label,
    iters: String(r.iters),
    min: ms(r.min),
    p50: ms(r.p50),
    p90: ms(r.p90),
    p99: ms(r.p99),
    mean: ms(r.mean),
    ratio: fastest > 0 && Number.isFinite(r.p50)
      ? `${(r.p50 / fastest).toFixed(r.p50 / fastest >= 10 ? 0 : 1)}×`
      : "—",
  }));

  const headers = {
    label: "path",
    iters: "n",
    min: "min",
    p50: "p50",
    p90: "p90",
    p99: "p99",
    mean: "mean",
    ratio: "vs fastest",
  };

  const width = (key: keyof typeof headers): number =>
    Math.max(
      headers[key].length,
      ...rows.map((row) => row[key].length),
    );

  const widths = {
    label: width("label"),
    iters: width("iters"),
    min: width("min"),
    p50: width("p50"),
    p90: width("p90"),
    p99: width("p99"),
    mean: width("mean"),
    ratio: width("ratio"),
  };

  const line = (cells: typeof headers): string =>
    [
      cells.label.padEnd(widths.label),
      cells.iters.padStart(widths.iters),
      cells.min.padStart(widths.min),
      cells.p50.padStart(widths.p50),
      cells.p90.padStart(widths.p90),
      cells.p99.padStart(widths.p99),
      cells.mean.padStart(widths.mean),
      cells.ratio.padStart(widths.ratio),
    ].join("  ");

  const out: string[] = [line(headers)];
  out.push("-".repeat(out[0].length));
  for (const row of rows) out.push(line(row));
  return out.join("\n");
}
