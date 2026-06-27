/**
 * Thin scenario registry for Sisal benchmarks.
 *
 * Deno owns timing, filtering, and reporting; this module keeps benchmark
 * scenarios grouped and reusable as the matrix grows.
 *
 * @module
 */

export interface BenchmarkScenario {
  readonly group: string;
  readonly name: string;
  readonly baseline?: boolean;
  readonly n?: number;
  readonly warmup?: number;
  readonly permissions?: Deno.PermissionOptions;
  readonly fn: Deno.BenchDefinition["fn"];
}

export function registerBenchmarkScenario(
  scenario: BenchmarkScenario,
): void {
  Deno.bench({
    group: scenario.group,
    name: scenario.name,
    baseline: scenario.baseline,
    n: scenario.n,
    warmup: scenario.warmup,
    permissions: scenario.permissions,
    fn: scenario.fn,
  });
}

export function registerBenchmarkScenarios(
  scenarios: readonly BenchmarkScenario[],
): void {
  for (const scenario of scenarios) {
    registerBenchmarkScenario(scenario);
  }
}
