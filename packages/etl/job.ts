/**
 * The typed ETL job model (v0.10 T12): {@link defineJob} declares a rollup —
 * source table, target table, time grain, watermark column, group keys, and
 * aggregate expressions — and validates the whole shape **at definition time**
 * against the tables' own column metadata: every projected key must be a
 * target column, the key sets must be disjoint, and every insert-required
 * target column must be covered, so a job that would generate un-runnable SQL
 * never constructs.
 *
 * A job is pure data over `@sisal/core` primitives (tables + `Sql`
 * aggregates); it carries no connection and generates no SQL itself —
 * `rollup()` compiles it, the runner executes it.
 *
 * @module
 */

import { isSql, OrmError } from "@sisal/core";
import type { AnyTableDefinition, DateTruncField, Sql } from "@sisal/core";
import { truncateToGrain } from "./window.ts";

/**
 * The bucket width of a rollup window — one calendar/clock unit per run,
 * matching the portable `dateTrunc` fields so the window edges the runner
 * computes and the buckets the database groups by can never disagree.
 */
export type EtlGrain = DateTruncField;

const GRAINS: readonly EtlGrain[] = [
  "year",
  "month",
  "day",
  "hour",
  "minute",
  "second",
];

// Leaves headroom under the checkpoint job-id (255) and advisory-lock name
// (255) limits once the runner's `sisal:etl:` prefix is added.
const MAX_JOB_NAME_LENGTH = 200;

/** A column definition belonging to `TTable` (from `table.columns`). */
export type ColumnOf<TTable extends AnyTableDefinition> =
  TTable["columns"][keyof TTable["columns"]];

/** A property key of `TTable`'s column map. */
export type ColumnKeyOf<TTable extends AnyTableDefinition> = Extract<
  keyof TTable["columns"],
  string
>;

/**
 * The declaration accepted by {@link defineJob}: which rows to read, where to
 * write them, and how to fold them.
 */
export interface EtlJobConfig<
  TSource extends AnyTableDefinition,
  TTarget extends AnyTableDefinition,
> {
  /**
   * Stable job id — keys the checkpoint row and the advisory-lock name, so
   * renaming it orphans the job's watermark. ≤ 200 characters.
   */
  readonly name: string;
  /** The table the rollup reads (the raw/event side). */
  readonly source: TSource;
  /** The table the rollup upserts into (the aggregate side). */
  readonly target: TTarget;
  /**
   * The source timestamp column that windows the job — rows are selected by
   * half-open `[from, until)` bounds on it and bucketed by `grain`.
   */
  readonly window: ColumnOf<TSource>;
  /** Bucket width; one grain is processed per run. */
  readonly grain: EtlGrain;
  /**
   * The target column that receives the `dateTrunc(grain, window)` bucket.
   * Part of the upsert key.
   */
  readonly bucket: ColumnKeyOf<TTarget>;
  /**
   * Group keys beyond the bucket: target column key → source column. Each is
   * projected, grouped by, and included in the upsert conflict target.
   */
  readonly groupBy?: Partial<Record<ColumnKeyOf<TTarget>, ColumnOf<TSource>>>;
  /**
   * Aggregate expressions: target column key → a `Sql` aggregate built from
   * core operators over source columns (`sum(...)`,
   * `filter(count(), eq(...))`, or a raw `` sql`...` `` combination). Each is
   * projected and re-set from `excluded()` on conflict, which is what makes a
   * re-run idempotent.
   */
  readonly aggregates: Partial<Record<ColumnKeyOf<TTarget>, Sql>>;
  /**
   * Where a job with no checkpoint starts, as an ISO-8601 instant. Must lie
   * exactly on a `grain` edge (UTC) so the first window covers whole buckets.
   * Without it, the first `run()` refuses instead of guessing.
   */
  readonly start?: string;
}

/**
 * A validated, frozen ETL job — the output of {@link defineJob} and the input
 * to `rollup()` and the runner. `groupBy`/`aggregates` are normalized to
 * plain records.
 */
export interface EtlJob<
  TSource extends AnyTableDefinition = AnyTableDefinition,
  TTarget extends AnyTableDefinition = AnyTableDefinition,
> {
  /** Discriminant for runtime checks. */
  readonly kind: "etl-job";
  /** Stable job id (checkpoint + lock key). */
  readonly name: string;
  /** The table the rollup reads. */
  readonly source: TSource;
  /** The table the rollup upserts into. */
  readonly target: TTarget;
  /** The source column that windows and buckets the job. */
  readonly window: ColumnOf<TSource>;
  /** Bucket width per run. */
  readonly grain: EtlGrain;
  /** Target column key receiving the bucket. */
  readonly bucket: string;
  /** Normalized group keys: target column key → source column. */
  readonly groupBy: Readonly<Record<string, ColumnOf<TSource>>>;
  /** Normalized aggregates: target column key → `Sql` expression. */
  readonly aggregates: Readonly<Record<string, Sql>>;
  /** Grain-aligned ISO start for a fresh job, if declared. */
  readonly start?: string;
}

function invalidJob(message: string, details?: Record<string, unknown>): never {
  throw new OrmError(message, {
    code: "ETL_INVALID_JOB",
    status: 400,
    details,
  });
}

function assertTable(
  value: AnyTableDefinition,
  label: string,
): void {
  if (value?.kind !== "table" || typeof value.columns !== "object") {
    invalidJob(`ETL job ${label} must be a table from defineTable()`);
  }
}

interface ColumnLike {
  readonly propertyName?: string;
  readonly tableName?: string;
}

function assertSourceColumn(
  source: AnyTableDefinition,
  value: unknown,
  label: string,
): void {
  const column = value as ColumnLike;
  if (
    typeof column?.propertyName !== "string" ||
    column.tableName !== source.name ||
    source.columns[column.propertyName] === undefined
  ) {
    invalidJob(
      `ETL job ${label} must be a column of the source table "${source.name}"`,
      { label },
    );
  }
}

/**
 * Validates and freezes an ETL rollup job. Throws `ETL_INVALID_JOB` when the
 * declaration cannot generate correct SQL: an unknown grain, a window column
 * not on the source, a `bucket`/`groupBy`/`aggregates` key that is not a
 * target column (or claimed twice), an empty aggregate set, an
 * insert-required target column left uncovered, or a `start` that is not a
 * grain-aligned ISO instant.
 *
 * ```ts
 * const job = defineJob({
 *   name: "post-hourly-stats",
 *   source: postEvents,
 *   target: postHourlyStats,
 *   window: postEvents.columns.occurred_at,
 *   grain: "hour",
 *   bucket: "bucket",
 *   groupBy: { post_id: postEvents.columns.post_id },
 *   aggregates: {
 *     views: filter(count(), eq(postEvents.columns.kind, "view")),
 *     votes: filter(count(), eq(postEvents.columns.kind, "vote")),
 *   },
 *   start: "2026-01-01T00:00:00.000Z",
 * });
 * ```
 */
export function defineJob<
  TSource extends AnyTableDefinition,
  TTarget extends AnyTableDefinition,
>(config: EtlJobConfig<TSource, TTarget>): EtlJob<TSource, TTarget> {
  const name = typeof config.name === "string" ? config.name.trim() : "";
  if (name.length === 0) {
    invalidJob("ETL job name is required");
  }
  if (name.length > MAX_JOB_NAME_LENGTH) {
    invalidJob(
      `ETL job name must be at most ${MAX_JOB_NAME_LENGTH} characters`,
      { name },
    );
  }
  assertTable(config.source, "source");
  assertTable(config.target, "target");
  if (!GRAINS.includes(config.grain)) {
    invalidJob(`Unknown ETL grain "${config.grain}"`, { grain: config.grain });
  }
  assertSourceColumn(config.source, config.window, "window column");

  const targetColumns = config.target.columns as Record<
    string,
    { readonly insertOptional?: boolean }
  >;
  const claimed = new Map<string, string>();
  const claim = (key: string, role: string): void => {
    if (targetColumns[key] === undefined) {
      invalidJob(
        `ETL job ${role} key "${key}" is not a column of the target table ` +
          `"${config.target.name}"`,
        { key, role },
      );
    }
    const previous = claimed.get(key);
    if (previous !== undefined) {
      invalidJob(
        `ETL job target column "${key}" is claimed twice (${previous} and ` +
          `${role})`,
        { key },
      );
    }
    claimed.set(key, role);
  };

  claim(config.bucket, "bucket");

  const groupBy: Record<string, ColumnOf<TSource>> = {};
  for (const [key, column] of Object.entries(config.groupBy ?? {})) {
    claim(key, "groupBy");
    assertSourceColumn(config.source, column, `groupBy "${key}"`);
    groupBy[key] = column as ColumnOf<TSource>;
  }

  const aggregates: Record<string, Sql> = {};
  for (const [key, expression] of Object.entries(config.aggregates ?? {})) {
    claim(key, "aggregates");
    if (!isSql(expression)) {
      invalidJob(
        `ETL job aggregate "${key}" must be a Sql expression ` +
          `(sum(...), filter(count(), ...), sql\`...\`)`,
        { key },
      );
    }
    aggregates[key] = expression;
  }
  if (Object.keys(aggregates).length === 0) {
    invalidJob("ETL job needs at least one aggregate");
  }

  const uncovered = Object.entries(targetColumns).filter(([key, column]) =>
    !claimed.has(key) && column.insertOptional !== true
  ).map(([key]) => key);
  if (uncovered.length > 0) {
    invalidJob(
      `ETL job leaves insert-required target column(s) uncovered: ` +
        uncovered.map((key) => `"${key}"`).join(", "),
      { uncovered },
    );
  }

  let start: string | undefined;
  if (config.start !== undefined) {
    const parsed = new Date(config.start);
    if (typeof config.start !== "string" || Number.isNaN(parsed.getTime())) {
      invalidJob(
        `ETL job start must be an ISO-8601 instant, got "${config.start}"`,
        { start: config.start },
      );
    }
    if (truncateToGrain(parsed, config.grain).getTime() !== parsed.getTime()) {
      invalidJob(
        `ETL job start must lie on a "${config.grain}" edge (UTC), got ` +
          `"${config.start}" — an unaligned start would make the first ` +
          `window cover a partial bucket`,
        { start: config.start, grain: config.grain },
      );
    }
    start = parsed.toISOString();
  }

  return Object.freeze({
    kind: "etl-job" as const,
    name,
    source: config.source,
    target: config.target,
    window: config.window,
    grain: config.grain,
    bucket: config.bucket,
    groupBy: Object.freeze(groupBy),
    aggregates: Object.freeze(aggregates),
    ...(start === undefined ? {} : { start }),
  });
}
