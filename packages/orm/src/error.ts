/**
 * Structured error primitives shared by Sisal packages — compatibility
 * re-export: the module lives in `@sisal/core` since the v0.8 extraction.
 * New code should import from `@sisal/core` directly.
 *
 * @module
 */

export { redactErrorCause, redactSecrets, SisalError } from "@sisal/core";
export type { SisalErrorOptions, SisalErrorSeverity } from "@sisal/core";
