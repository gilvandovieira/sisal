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
    super(message, { cause: options.cause });
    this.name = "SisalError";
    this.code = options.code ?? "SISAL_UNKNOWN_ERROR";
    this.status = options.status ?? 500;
    this.expose = options.expose ?? false;
    this.severity = options.severity ?? "error";
    this.details = options.details;
  }
}
