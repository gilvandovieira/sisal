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

// A password embedded in a URL's userinfo: `scheme://user:secret@host`. The
// password may itself contain `@` or `/`, so match it lazily up to the `@host`
// boundary — the host has no `/`/`:`/`@` and is followed by a port, path,
// query, delimiter, or end of string.
const URL_USERINFO_SECRET =
  /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s]*?)(@[^\s:/@]+)(?=[:/?#\s"']|$)/gi;
// A credential-bearing key/value pair in a DSN, query string, or message.
const SECRET_PARAM =
  /((?:auth[_-]?token|access[_-]?token|api[_-]?key|apikey|encryption[_-]?key|password|passwd|pwd|secret|token)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&;,"']+)/gi;
// A credential in a SQL grant/role statement — e.g. `IDENTIFIED BY 'pw'`,
// `PASSWORD 'pw'`. The value is always a quoted literal, so requiring quotes
// avoids masking an ordinary `password` column reference.
const SQL_SECRET =
  /((?:identified\s+by|identified\s+with\s+\S+\s+by|encrypted\s+password|password)\s+)('[^']*'|"[^"]*")/gi;

/**
 * Masks credentials in a string: passwords in a URL's userinfo, the values of
 * credential-bearing parameters (`password`, `authToken`, `token`, `apiKey`,
 * `secret`, `encryptionKey`, …), and credentials in SQL grant/role statements
 * (`IDENTIFIED BY '…'`, `PASSWORD '…'`). Use it before logging or surfacing
 * anything that may contain a connection string. Non-secret text passes through
 * unchanged.
 */
export function redactSecrets(text: string): string {
  if (typeof text !== "string" || text.length === 0) {
    return text;
  }
  return text
    .replace(URL_USERINFO_SECRET, "$1***$3")
    .replace(SECRET_PARAM, "$1***")
    .replace(SQL_SECRET, "$1***");
}

// Driver errors attach bind values and rendered statements to enumerable
// properties (mysql2 `sql`, pg/postgres.js `parameters`, MariaDB param echoes).
// These hold arbitrary values that pattern redaction cannot catch, so drop them
// wholesale when sanitizing a preserved cause.
const BIND_KEYS: ReadonlySet<string> = new Set([
  "parameters",
  "params",
  "values",
  "bindings",
  "sql",
  "query",
]);
// Enumerable properties whose *value* is a bare credential (no `key=value`
// shape for the pattern matcher to catch), e.g. a driver `config.password`.
const CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "authtoken",
  "accesstoken",
  "apikey",
  "encryptionkey",
  "uri",
  "dsn",
  "connectionstring",
  "connectionuri",
]);
const MAX_REDACT_DEPTH = 6;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

// Recursively redacts a value. `aggressive` (used for a preserved error `cause`)
// drops bind/statement properties and masks credential-named properties;
// off (used for structured `details`) only redacts secret patterns in strings,
// so Sisal's own diagnostic fields — including the parameterized `sql` — survive.
function redactValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  aggressive: boolean,
): unknown {
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (depth >= MAX_REDACT_DEPTH) {
    return "[redacted: max depth]";
  }
  if (seen.has(value)) {
    return "[redacted: circular]";
  }
  seen.add(value);
  if (value instanceof Error) {
    // Our own errors already redact their message, cause, and details in their
    // constructor. Pass them through unchanged so their type survives (callers
    // rely on `cause instanceof OrmError` and on reading `cause.details`) and
    // we do not double-redact. Only foreign driver errors are rebuilt.
    if (value instanceof SisalError) {
      return value;
    }
    return sanitizeErrorLike(value, seen, depth, aggressive);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen, depth + 1, aggressive));
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    out[key] = redactProperty(
      key,
      (value as Record<string, unknown>)[key],
      seen,
      depth,
      aggressive,
    );
  }
  return out;
}

function redactProperty(
  key: string,
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  aggressive: boolean,
): unknown {
  if (aggressive) {
    const norm = normalizeKey(key);
    if (BIND_KEYS.has(norm)) {
      return Array.isArray(value)
        ? `[${value.length} value(s) redacted]`
        : "[redacted]";
    }
    if (CREDENTIAL_KEYS.has(norm)) {
      return "***";
    }
  }
  return redactValue(value, seen, depth + 1, aggressive);
}

function sanitizeErrorLike(
  error: Error,
  seen: WeakSet<object>,
  depth: number,
  aggressive: boolean,
): Error {
  const message = redactSecrets(error.message);
  const stack = error.stack === undefined
    ? undefined
    : redactSecrets(error.stack);
  const ownKeys = Object.keys(error);
  const nestedCause = (error as { cause?: unknown }).cause;
  const nestedErrors = (error as { errors?: unknown }).errors;
  // Nothing to sanitize — preserve identity so `instanceof` still works for an
  // ordinary thrown error with a clean message and no attached properties.
  if (
    ownKeys.length === 0 && nestedCause === undefined &&
    nestedErrors === undefined && message === error.message &&
    stack === error.stack
  ) {
    return error;
  }
  const sanitized = new Error(message);
  sanitized.name = error.name;
  if (stack !== undefined) {
    sanitized.stack = stack;
  }
  const source = error as unknown as Record<string, unknown>;
  const target = sanitized as unknown as Record<string, unknown>;
  for (const key of ownKeys) {
    target[key] = redactProperty(key, source[key], seen, depth, aggressive);
  }
  if (nestedCause !== undefined) {
    (sanitized as { cause?: unknown }).cause = redactValue(
      nestedCause,
      seen,
      depth + 1,
      aggressive,
    );
  }
  // AggregateError (and any driver error exposing an `errors` array).
  if (Array.isArray(nestedErrors)) {
    (sanitized as { errors?: unknown }).errors = nestedErrors.map((item) =>
      redactValue(item, seen, depth + 1, aggressive)
    );
  }
  return sanitized;
}

/**
 * Returns a cause with secrets masked throughout — its `message`/`stack`, and
 * recursively its enumerable properties, nested `cause`, and `AggregateError`
 * `errors`. Driver errors carry bind values (`parameters`) and rendered SQL
 * (`sql`) on enumerable properties that a serializer would otherwise expose, so
 * those are dropped and credential-named fields masked. An ordinary error with
 * a clean message and no attached properties is returned unchanged. Used by
 * {@link SisalError} and exported for error types that do not extend it.
 */
export function redactErrorCause(cause: unknown): unknown {
  return redactValue(cause, new WeakSet(), 0, true);
}

// Redacts secret *patterns* in the string fields of structured error details,
// preserving keys and non-secret values — Sisal's `details.sql` is
// parameterized, but a raw migration statement can inline a credential.
function redactDetails(
  details: Record<string, unknown>,
): Record<string, unknown> {
  return redactValue(details, new WeakSet(), 0, false) as Record<
    string,
    unknown
  >;
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
    // `details` often carries the parameterized SQL for diagnostics; a raw
    // migration statement can still inline a credential, so redact secret
    // patterns in its string fields while preserving the structure.
    this.details = options.details === undefined
      ? undefined
      : redactDetails(options.details);
  }
}
