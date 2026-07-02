/**
 * Minimal logging contract accepted by Sisal facades — compatibility
 * re-export: the module lives in `@sisal/core` since the v0.8 extraction.
 * New code should import from `@sisal/core` directly.
 *
 * @module
 */

export {
  createSisalLogEmitter,
  emitSisalLogEvent,
  isSisalLogCategory,
  isSisalLogLevel,
  logEnabled,
  normalizeSisalLogSettings,
  redactSqlParameter,
  redactSqlParameters,
} from "@sisal/core";
export type {
  CreateSisalLogEmitterOptions,
  Logger,
  LoggerMethod,
  NormalizedSisalLogging,
  SisalLogCategory,
  SisalLogCategorySettings,
  SisalLogEmitter,
  SisalLogEvent,
  SisalLoggingOptions,
  SisalLogLevel,
  SisalLogSettings,
  SisalSqlLogSettings,
} from "@sisal/core";
