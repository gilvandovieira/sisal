/**
 * Logging contracts accepted by Sisal packages.
 *
 * Sisal never logs on its own: attach a {@link Logger} and it emits structured
 * events; attach nothing and it is completely silent (query failures still
 * throw — the thrown {@link SisalError} carries the redacted detail). The sink
 * you pass decides everything else — where events go, how they are formatted,
 * and, through the optional {@link Logger.isEnabled} hook, which levels are
 * worth building at all.
 *
 * Bring your own sink or use a bundled bridge: {@link consoleLogger} (zero
 * setup), {@link fromStdLog} (adapts an `@std/log` logger), or the
 * `examples/logging` Pino bridge. {@link developmentLogging} /
 * {@link productionLogging} are ready-made verbosity presets.
 *
 * @module
 */

import { redactSecrets } from "./error.ts";

/** Log levels accepted by Sisal's structured logging controls. */
export type SisalLogLevel =
  | "silent"
  | "error"
  | "warn"
  | "info"
  | "debug"
  | "trace";

/** A log level that actually emits an event (every level except `silent`). */
export type SisalLogLevelActive = Exclude<SisalLogLevel, "silent">;

/** Hibernate-style categories Sisal can use to filter logging events. */
export type SisalLogCategory =
  | "orm.query"
  | "orm.sql"
  | "orm.bind"
  | "orm.result"
  | "orm.batch"
  | "orm.transaction"
  | "migrate.plan"
  | "migrate.step"
  | "migrate.sql"
  | "migrate.lock"
  | "migrate.history"
  | "cli";

/** Per-category level overrides accepted by {@link SisalLogSettings}. */
export type SisalLogCategorySettings = Partial<
  Record<SisalLogCategory, SisalLogLevel | boolean>
>;

/** How SQL bind parameters are rendered into logs. */
export type SisalSqlParameterMode = "off" | "redacted" | "values";

/** SQL logging controls accepted by Sisal packages. */
export interface SisalSqlLogSettings {
  /**
   * How bind parameters appear in logs:
   *
   * - `"off"` — bind parameters are omitted entirely, even their cardinality.
   * - `"redacted"` (default) — safe, non-raw summaries: strings collapse to a
   *   length plus a secret-detected flag, bytes to a byte length, objects to a
   *   redacted key list. Low-cardinality scalars (numbers, booleans) keep their
   *   value so the log stays useful.
   * - `"values"` — the **raw** bind values, so a failing query can be replayed
   *   verbatim while debugging. This can put user data (and secrets a query is
   *   inserting) into your logs, so it is opt-in and best reserved for local
   *   development or a scoped production incident. Connection strings and DSNs
   *   are a **separate** concern and are always redacted regardless of this
   *   setting (see {@link redactSecrets} and {@link SisalError}).
   */
  readonly parameters?: SisalSqlParameterMode;
}

/** Shared logging settings accepted by Sisal packages and the migration CLI. */
export interface SisalLogSettings {
  readonly level?: SisalLogLevel;
  readonly categories?: SisalLogCategorySettings;
  readonly sql?: SisalSqlLogSettings;
}

/** Shared logging options accepted by Sisal facades. */
export interface SisalLoggingOptions extends SisalLogSettings {
  readonly logger?: Logger;
}

/** A structured Sisal log event handed to a {@link Logger}. */
export interface SisalLogEvent {
  readonly level: SisalLogLevelActive;
  readonly category: SisalLogCategory;
  readonly message: string;
  readonly record?: Record<string, unknown>;
}

/**
 * The sink Sisal writes to — the single, most-extensible logging contract.
 *
 * A logger receives one {@link SisalLogEvent} at a time through {@link log} and
 * decides everything: routing by level, filtering by category, formatting, and
 * transport. Adapt any backend to this shape with a bundled bridge
 * ({@link consoleLogger}, {@link fromStdLog}) or a few lines of your own.
 */
export interface Logger {
  /**
   * Fast pre-check Sisal calls **before** building a potentially expensive
   * event record (bind-parameter redaction, result timing). Return `false` to
   * have Sisal skip the work entirely.
   *
   * Optional: when absent, Sisal assumes every level that passes its own
   * configured threshold is wanted. Bridge it to your backend's own level gate
   * (for example `pino.isLevelEnabled(level)`) so a high verbosity setting
   * costs nothing when the sink would drop the event anyway.
   */
  isEnabled?(level: SisalLogLevelActive, category: SisalLogCategory): boolean;
  /** Receives one structured event that already passed level/category gating. */
  log(event: SisalLogEvent): void;
}

/** Normalized logging controls used by Sisal internals. */
export interface NormalizedSisalLogging {
  readonly logger?: Logger;
  readonly level: SisalLogLevel;
  readonly categories: SisalLogCategorySettings;
  readonly sql: Required<SisalSqlLogSettings>;
  readonly metadata: boolean;
}

/** Event emitter returned by {@link createSisalLogEmitter}. */
export interface SisalLogEmitter {
  readonly settings: NormalizedSisalLogging;
  enabled(
    level: SisalLogLevelActive,
    category: SisalLogCategory,
  ): boolean;
  emit(event: SisalLogEvent): void;
}

/** Options for {@link createSisalLogEmitter}. */
export interface CreateSisalLogEmitterOptions {
  readonly logger?: Logger;
  readonly logging?: SisalLoggingOptions | SisalLogSettings;
  readonly defaultLevel?: SisalLogLevel;
  readonly metadata?: boolean;
}

const LOG_LEVEL_ORDER: Record<SisalLogLevel, number> = {
  silent: -1,
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

const LOG_LEVELS = new Set<SisalLogLevel>([
  "silent",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
]);

const LOG_CATEGORIES = new Set<SisalLogCategory>([
  "orm.query",
  "orm.sql",
  "orm.bind",
  "orm.result",
  "orm.batch",
  "orm.transaction",
  "migrate.plan",
  "migrate.step",
  "migrate.sql",
  "migrate.lock",
  "migrate.history",
  "cli",
]);

/** Returns true when a value is one of Sisal's supported log levels. */
export function isSisalLogLevel(value: unknown): value is SisalLogLevel {
  return typeof value === "string" && LOG_LEVELS.has(value as SisalLogLevel);
}

/** Returns true when a value is one of Sisal's supported log categories. */
export function isSisalLogCategory(
  value: unknown,
): value is SisalLogCategory {
  return typeof value === "string" &&
    LOG_CATEGORIES.has(value as SisalLogCategory);
}

/** Creates a level/category-aware logger wrapper for Sisal internals. */
export function createSisalLogEmitter(
  options: CreateSisalLogEmitterOptions = {},
): SisalLogEmitter {
  const logging = options.logging;
  const loggingLogger = isRecord(logging) && "logger" in logging
    ? (logging as SisalLoggingOptions).logger
    : undefined;
  const logger = loggingLogger ?? options.logger;
  const settings = normalizeSisalLogSettings(logging, {
    logger,
    defaultLevel: options.defaultLevel,
    metadata: options.metadata,
  });

  return {
    settings,
    enabled(level, category) {
      return logEnabled(settings, level, category);
    },
    emit(event) {
      emitSisalLogEvent(settings, event);
    },
  };
}

/** Normalizes logging settings with conservative defaults. */
export function normalizeSisalLogSettings(
  settings: SisalLoggingOptions | SisalLogSettings | undefined,
  options: {
    readonly logger?: Logger;
    readonly defaultLevel?: SisalLogLevel;
    readonly metadata?: boolean;
  } = {},
): NormalizedSisalLogging {
  return {
    logger: options.logger,
    level: settings?.level ?? options.defaultLevel ?? "info",
    categories: settings?.categories ?? {},
    sql: {
      parameters: settings?.sql?.parameters ?? "redacted",
    },
    metadata: options.metadata ?? settings !== undefined,
  };
}

/**
 * Returns true when an event should be emitted for normalized settings.
 *
 * Two gates in series: Sisal's own level/category configuration, then — when
 * the sink implements it — {@link Logger.isEnabled}. The sink can only narrow,
 * never widen, so its own verbosity is always respected while Sisal's config
 * keeps a category quiet even if the sink would accept it.
 */
export function logEnabled(
  settings: NormalizedSisalLogging,
  level: SisalLogLevelActive,
  category: SisalLogCategory,
): boolean {
  const logger = settings.logger;
  if (logger === undefined || settings.level === "silent") {
    return false;
  }

  const categorySetting = settings.categories[category];
  if (categorySetting === false) {
    return false;
  }

  if (categorySetting !== true) {
    const threshold = categorySetting ?? settings.level;
    if (threshold === "silent") {
      return false;
    }
    if (LOG_LEVEL_ORDER[level] > LOG_LEVEL_ORDER[threshold]) {
      return false;
    }
  }

  return logger.isEnabled?.(level, category) ?? true;
}

/** Emits one structured event, swallowing logger failures. */
export function emitSisalLogEvent(
  settings: NormalizedSisalLogging,
  event: SisalLogEvent,
): void {
  const logger = settings.logger;
  if (
    logger === undefined ||
    !logEnabled(settings, event.level, event.category)
  ) {
    return;
  }

  try {
    const record = settings.metadata
      ? {
        ...(event.record ?? {}),
        level: event.level,
        category: event.category,
      }
      : event.record;

    logger.log(record === event.record ? event : { ...event, record });
  } catch {
    // Logging must never break database work.
  }
}

/**
 * Renders SQL bind parameters for a log record according to the parameter mode.
 *
 * `"redacted"` yields the safe non-raw summaries of {@link redactSqlParameters};
 * `"values"` returns the raw values verbatim (opt-in — see
 * {@link SisalSqlLogSettings}). `"off"` should be handled by the caller before
 * reaching here (it returns the raw array unchanged as a defensive default).
 */
export function renderSqlParametersForLog(
  parameters: readonly unknown[],
  mode: SisalSqlParameterMode,
): readonly unknown[] {
  return mode === "redacted" ? redactSqlParameters(parameters) : parameters;
}

/** Builds safe, non-raw summaries for SQL bind parameters. */
export function redactSqlParameters(
  parameters: readonly unknown[],
): readonly Record<string, unknown>[] {
  return parameters.map((parameter) => redactSqlParameter(parameter));
}

/** Builds a safe, non-raw summary for one SQL bind parameter. */
export function redactSqlParameter(
  parameter: unknown,
): Record<string, unknown> {
  if (parameter === null) {
    return { type: "null" };
  }

  switch (typeof parameter) {
    case "string":
      return {
        type: "string",
        length: parameter.length,
        redacted: redactSecrets(parameter) !== parameter,
      };
    case "number":
      return { type: "number", value: parameter };
    case "boolean":
      return { type: "boolean", value: parameter };
    case "bigint":
      return { type: "bigint", digits: parameter.toString().length };
    case "undefined":
      return { type: "undefined" };
    case "symbol":
      return { type: "symbol" };
    case "function":
      return { type: "function" };
    case "object":
      break;
  }

  if (parameter instanceof Date) {
    return { type: "date" };
  }

  if (parameter instanceof Uint8Array) {
    return { type: "bytes", byteLength: parameter.byteLength };
  }

  if (parameter instanceof ArrayBuffer) {
    return { type: "bytes", byteLength: parameter.byteLength };
  }

  if (Array.isArray(parameter)) {
    return { type: "array", length: parameter.length };
  }

  if (isRecord(parameter)) {
    const keys = Object.keys(parameter);
    return {
      type: "object",
      keyCount: keys.length,
      keys: keys.slice(0, 10).map(redactSecrets),
    };
  }

  return { type: "unknown" };
}

/** A `console`-like target accepted by {@link consoleLogger}. */
export interface ConsoleLike {
  error(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  info(...data: unknown[]): void;
  debug(...data: unknown[]): void;
}

/** Options for {@link consoleLogger}. */
export interface ConsoleLoggerOptions {
  /** The lowest level to print. Defaults to `"debug"`. */
  readonly level?: SisalLogLevelActive;
  /** The console-like target. Defaults to the global `console`. */
  readonly console?: ConsoleLike;
}

/**
 * A zero-dependency {@link Logger} that prints structured events to `console`.
 *
 * Errors and warnings go to `console.error` / `console.warn`; everything else
 * to `console.info` / `console.debug`. Each event renders as
 * `[level] category: message {record}`. Pass `level` to gate cheaply through
 * {@link Logger.isEnabled} so events below it never build a record.
 */
export function consoleLogger(options: ConsoleLoggerOptions = {}): Logger {
  const sink = options.console ?? console;
  const min = options.level;
  return {
    ...(min === undefined ? {} : {
      isEnabled(level) {
        return LOG_LEVEL_ORDER[level] <= LOG_LEVEL_ORDER[min];
      },
    }),
    log(event) {
      const suffix = event.record === undefined
        ? ""
        : ` ${JSON.stringify(event.record)}`;
      const line = `[${event.level}] ${event.category}: ${event.message}` +
        suffix;
      if (event.level === "error") {
        sink.error(line);
      } else if (event.level === "warn") {
        sink.warn(line);
      } else if (event.level === "info") {
        sink.info(line);
      } else {
        sink.debug(line);
      }
    },
  };
}

/**
 * An `@std/log`-style logger: level methods that take `(message, ...args)`.
 *
 * Duck-typed so Sisal takes no dependency on `@std/log` — pass the result of
 * `log.getLogger(...)`.
 */
export interface StdLogLike {
  debug(message: string, ...args: unknown[]): unknown;
  info(message: string, ...args: unknown[]): unknown;
  warn(message: string, ...args: unknown[]): unknown;
  error(message: string, ...args: unknown[]): unknown;
}

/**
 * Bridges an `@std/log` logger to Sisal's {@link Logger}.
 *
 * Sisal's structured record rides along as the std/log trailing arg, and its
 * `trace` level folds into `debug` (std/log has no `trace`). Level gating is
 * left to std/log's own handlers plus Sisal's configured level.
 */
export function fromStdLog(logger: StdLogLike): Logger {
  return {
    log(event) {
      const method = event.level === "warn"
        ? logger.warn
        : event.level === "error"
        ? logger.error
        : event.level === "info"
        ? logger.info
        : logger.debug;
      if (event.record === undefined) {
        method.call(logger, event.message);
      } else {
        method.call(logger, event.message, event.record);
      }
    },
  };
}

/**
 * A verbose preset for local development: `debug` everywhere, bind parameters
 * as **raw values** so a query can be copied and replayed, and per-row result
 * events on. Combine with any sink, e.g.
 * `createDatabase({ ..., logging: developmentLogging(consoleLogger()) })`.
 */
export function developmentLogging(logger: Logger): SisalLoggingOptions {
  return {
    logger,
    level: "debug",
    categories: { "orm.bind": "trace" },
    sql: { parameters: "values" },
  };
}

/**
 * A quiet preset for production: `warn` and `error` only, with bind parameters
 * redacted. Failing queries still log their SQL text (an `orm.query` error
 * event) so you can locate them; raise the level or switch to
 * {@link developmentLogging} to capture parameters while chasing an incident.
 */
export function productionLogging(logger: Logger): SisalLoggingOptions {
  return {
    logger,
    level: "warn",
    sql: { parameters: "redacted" },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
