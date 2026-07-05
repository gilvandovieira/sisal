/**
 * Structured error type for the `@sisal/orm` core.
 *
 * Part of `@sisal/core`; re-exported through `./mod.ts`.
 */

import { SisalError } from "./error.ts";

/** Error codes emitted by ORM schema, SQL, driver, and transaction helpers. */
export type OrmErrorCode =
  | "ORM_INVALID_TABLE"
  | "ORM_INVALID_COLUMN"
  | "ORM_INVALID_QUERY"
  | "ORM_INVALID_SQL"
  | "ORM_DIALECT_UNSUPPORTED"
  | "ORM_DRIVER_MISSING"
  | "ORM_EXECUTE_FAILED"
  | "ORM_TRANSACTION_FAILED"
  | "ORM_TRANSACTION_UNSUPPORTED"
  | "ORM_BATCH_FAILED"
  | "ORM_SERIALIZATION_FAILED"
  | "ORM_UNKNOWN_ERROR"
  | (string & Record<never, never>);

/** Options accepted when constructing an {@link OrmError}. */
export interface OrmErrorOptions {
  /** HTTP-style status associated with this orm error options. */
  readonly code?: OrmErrorCode;
  /** Whether this orm error options can be shown to callers. */
  readonly status?: number;
  /** Severity level associated with this orm error options. */
  readonly expose?: boolean;
  /** Structured diagnostic details for this orm error options. */
  readonly severity?: "debug" | "info" | "warn" | "error" | "fatal";
  /** Original cause associated with this orm error options. */
  readonly details?: Record<string, unknown>;
  /** Original cause associated with this orm error options. */
  readonly cause?: unknown;
}

/** Error thrown for schema, SQL, execution, and transaction failures. */
export class OrmError extends SisalError {
  /** Creates an ORM error. */
  constructor(message: string, options: OrmErrorOptions = {}) {
    super(message, {
      code: options.code ?? "ORM_UNKNOWN_ERROR",
      status: options.status ?? 500,
      expose: options.expose ?? false,
      severity: options.severity ?? "error",
      details: options.details,
      cause: options.cause,
    });
  }
}
