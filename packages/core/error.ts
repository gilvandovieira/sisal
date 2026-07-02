/**
 * Structured error primitives shared by Sisal packages.
 *
 * @module
 */

/** Severity attached to structured Sisal errors. */
export type SisalErrorSeverity =
  | "debug"
  | "info"
  | "warn"
  | "error"
  | "fatal";

// A password embedded in a URL's userinfo: `scheme://user:secret@host`.
const URL_USERINFO_SECRET = /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s/@]+)(@)/gi;
// A credential-bearing key/value pair in a DSN, query string, or message.
const SECRET_PARAM =
  /((?:auth[_-]?token|access[_-]?token|api[_-]?key|apikey|password|passwd|pwd|secret|token)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&;,"']+)/gi;

/**
 * Masks credentials in a string: passwords in a URL's userinfo and the values
 * of credential-bearing parameters (`password`, `authToken`, `token`, `apiKey`,
 * `secret`, …). Use it before logging or surfacing anything that may contain a
 * connection string. Non-secret text passes through unchanged.
 */
export function redactSecrets(text: string): string {
  if (typeof text !== "string" || text.length === 0) {
    return text;
  }
  return text
    .replace(URL_USERINFO_SECRET, "$1***$3")
    .replace(SECRET_PARAM, "$1***");
}

/**
 * Returns a cause with any secrets in its `message`/`stack` masked. The original
 * is kept when there is nothing to redact, so ordinary debugging is unaffected;
 * only credential-bearing errors are replaced with a sanitized copy. Used by
 * {@link SisalError} and exported for error types that do not extend it.
 */
export function redactErrorCause(cause: unknown): unknown {
  if (typeof cause === "string") {
    return redactSecrets(cause);
  }
  if (!(cause instanceof Error)) {
    return cause;
  }
  const message = redactSecrets(cause.message);
  const stack = cause.stack === undefined
    ? undefined
    : redactSecrets(cause.stack);
  if (message === cause.message && stack === cause.stack) {
    return cause;
  }
  const sanitized = new Error(message);
  sanitized.name = cause.name;
  if (stack !== undefined) {
    sanitized.stack = stack;
  }
  return sanitized;
}

/** Options accepted by {@link SisalError}. */
export interface SisalErrorOptions {
  readonly code?: string;
  readonly status?: number;
  readonly expose?: boolean;
  readonly severity?: SisalErrorSeverity;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

/**
 * Small structured error primitive shared by Sisal packages.
 *
 * It intentionally avoids bringing a broader application framework into this
 * database toolkit.
 */
export class SisalError extends Error {
  readonly code: string;
  readonly status: number;
  readonly expose: boolean;
  readonly severity: SisalErrorSeverity;
  readonly details?: Record<string, unknown>;

  constructor(message: string, options: SisalErrorOptions = {}) {
    // Credentials must never leak through an error: redact the message and any
    // preserved cause (a driver's connection error can echo the DSN/password).
    super(redactSecrets(message), { cause: redactErrorCause(options.cause) });
    this.name = "SisalError";
    this.code = options.code ?? "SISAL_UNKNOWN_ERROR";
    this.status = options.status ?? 500;
    this.expose = options.expose ?? false;
    this.severity = options.severity ?? "error";
    this.details = options.details;
  }
}
