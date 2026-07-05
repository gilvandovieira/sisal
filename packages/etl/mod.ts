/**
 * # @sisal/etl — SQL-pushdown ETL for Sisal (v0.10 preview)
 *
 * Define a rollup job in TypeScript and execute **one** safe, idempotent
 * window per invocation, with the heavy lifting pushed down into the
 * database:
 *
 * - {@link defineJob} — the typed job model: source, target, grain, window
 *   column, group keys, aggregates; validated at definition time.
 * - {@link rollup} — compiles a job + window into a single generated
 *   insert-from-select + upsert statement (`@sisal/core` assembly; no row
 *   round-trips).
 * - {@link nextWindow} — half-open `[from, until)` window math, aligned to
 *   UTC grain edges and never past `now`.
 * - {@link run} — the single-window runner: advisory lock → checkpoint →
 *   generated SQL → atomic watermark advance. An external scheduler decides
 *   *when*; Sisal decides *what one run means*.
 * - {@link backfill} / {@link replay} — deterministic historical re-runs
 *   (never advancing the checkpoint), guarded by the `pruned_before` replay
 *   horizon with a loud `unsafeAllowPrunedReplay` override.
 * - {@link status} — the read-only checkpoint / next-window report.
 * - {@link explain} — dry-run: the exact generated SQL, rendered per dialect,
 *   without executing.
 *
 * Deliberately **not** a scheduler, worker queue, or orchestration platform.
 *
 * The job/SQL tiers depend on `@sisal/core` only; the runner consumes the
 * v0.9 checkpoint + advisory-lock substrate from `@sisal/orm` (the runtime
 * edge recorded in `docs/architecture.md`). `@sisal/orm` never imports this
 * package.
 *
 * @module
 */

export {
  type ColumnKeyOf,
  type ColumnOf,
  defineJob,
  type EtlGrain,
  type EtlJob,
  type EtlJobConfig,
} from "./src/job.ts";
export {
  addGrain,
  type EtlRange,
  type EtlWindow,
  nextWindow,
  type NextWindowParts,
  truncateToGrain,
  windowAt,
  windowsInRange,
} from "./src/window.ts";
export { type EtlExplainOptions, explain, rollup } from "./src/rollup.ts";
export {
  assertJobSupported,
  ETL_DIALECTS,
  type EtlJobSupport,
  supportsJob,
} from "./src/capability.ts";
export {
  backfill,
  type EtlBackfillOutcome,
  type EtlReplayOptions,
  type EtlReplayOutcome,
  type EtlRunOptions,
  type EtlRunOutcome,
  type EtlStatus,
  type EtlStatusOptions,
  replay,
  run,
  status,
} from "./src/runner.ts";
