/**
 * Minimal logging contract accepted by Sisal facades — compatibility
 * re-export: the module lives in `@sisal/core` since the v0.8 extraction.
 * New code should import from `@sisal/core` directly.
 *
 * @module
 */

export type { Logger, LoggerMethod } from "@sisal/core";
