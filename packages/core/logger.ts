/**
 * Minimal logger contracts accepted by Sisal packages.
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

/** SQL logging controls accepted by Sisal packages. */
export interface SisalSqlLogSettings {
  /**
   * Whether bind parameters are omitted (`"off"`) or emitted as safe summaries
   * (`"redacted"`).
   *
   * A redacted summary never includes raw string, binary, date, or object bind
   * values — strings collapse to a length plus a secret-detected flag, bytes to
   * a byte length, objects to a redacted key list. Low-cardinality scalars
   * (numbers and booleans) are summarized with their value so the log stays
   * useful; pass `"off"` when even those must not appear.
   */
  readonly parameters?: "off" | "redacted";
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

export interface LoggerMethod {
  (message: string): void;
  (record: Record<string, unknown>, message: string): void;
}

/**
 * Minimal logger contract accepted by Sisal packages.
 *
 * Pequi Logger is a good fit for this shape, but Sisal does not depend on it.
 */
export interface Logger {
  readonly trace?: LoggerMethod;
  readonly debug: LoggerMethod;
  readonly info: LoggerMethod;
  readonly warn: LoggerMethod;
  readonly error: LoggerMethod;
}

/** A structured Sisal log event after level/category resolution. */
export interface SisalLogEvent {
  readonly level: Exclude<SisalLogLevel, "silent">;
  readonly category: SisalLogCategory;
  readonly message: string;
  readonly record?: Record<string, unknown>;
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
    level: Exclude<SisalLogLevel, "silent">,
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

/** Returns true when an event should be emitted for normalized settings. */
export function logEnabled(
  settings: NormalizedSisalLogging,
  level: Exclude<SisalLogLevel, "silent">,
  category: SisalLogCategory,
): boolean {
  if (settings.logger === undefined || settings.level === "silent") {
    return false;
  }

  const categorySetting = settings.categories[category];
  if (categorySetting === false) {
    return false;
  }
  if (categorySetting === true) {
    return true;
  }

  const threshold = categorySetting ?? settings.level;
  if (threshold === "silent") {
    return false;
  }

  return LOG_LEVEL_ORDER[level] <= LOG_LEVEL_ORDER[threshold];
}

/** Emits one structured event, swallowing logger failures. */
export function emitSisalLogEvent(
  settings: NormalizedSisalLogging,
  event: SisalLogEvent,
): void {
  if (!logEnabled(settings, event.level, event.category)) {
    return;
  }

  try {
    const logger = settings.logger;
    if (logger === undefined) {
      return;
    }

    const method = event.level === "trace"
      ? logger.trace ?? logger.debug
      : logger[event.level];
    const record = settings.metadata
      ? {
        ...(event.record ?? {}),
        level: event.level,
        category: event.category,
      }
      : event.record;

    if (record === undefined) {
      if (event.level === "trace" && logger.trace === undefined) {
        method({ level: "trace", category: event.category }, event.message);
      } else {
        method(event.message);
      }
      return;
    }

    if (event.level === "trace" && logger.trace === undefined) {
      method(
        { ...record, level: "trace", category: event.category },
        event.message,
      );
      return;
    }

    method(record, event.message);
  } catch {
    // Logging must never break database work.
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
