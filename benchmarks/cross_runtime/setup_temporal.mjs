// Ensures a `Temporal` global exists before Sisal loads. Sisal's core uses
// Temporal on the render path; Deno and Node 24+ expose it natively, but Bun
// (as of 1.3) does not. This module is imported *first* by bench.mjs — ESM
// evaluates imports in source order, so the global is installed before
// `@sisaljs/*` is evaluated. Runtimes with native Temporal are untouched; only
// the polyfilled runtime sets the flag the bench reports as its caveat.
if (globalThis.Temporal === undefined) {
  const { Temporal } = await import("@js-temporal/polyfill");
  globalThis.Temporal = Temporal;
  globalThis.__SISAL_TEMPORAL_POLYFILL__ = true;
}
