/**
 * Logging contracts accepted by Sisal facades — compatibility re-export: the
 * module lives in `@sisal/core` since the v0.8 extraction. New code should
 * import from `@sisal/core` directly.
 *
 * @module
 */

export {
  consoleLogger,
  createSisalLogEmitter,
  developmentLogging,
  emitSisalLogEvent,
  fromStdLog,
  isSisalLogCategory,
  isSisalLogLevel,
  logEnabled,
  normalizeSisalLogSettings,
  productionLogging,
  redactSqlParameter,
  redactSqlParameters,
  renderSqlParametersForLog,
} from "@sisal/core";
export type {
  ConsoleLike,
  ConsoleLoggerOptions,
  CreateSisalLogEmitterOptions,
  Logger,
  NormalizedSisalLogging,
  SisalLogCategory,
  SisalLogCategorySettings,
  SisalLogEmitter,
  SisalLogEvent,
  SisalLoggingOptions,
  SisalLogLevel,
  SisalLogLevelActive,
  SisalLogSettings,
  SisalSqlLogSettings,
  SisalSqlParameterMode,
  StdLogLike,
} from "@sisal/core";
