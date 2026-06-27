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
  readonly debug: LoggerMethod;
  readonly info: LoggerMethod;
  readonly warn: LoggerMethod;
  readonly error: LoggerMethod;
}
