import type { IntegrationScenario, IntegrationTarget } from "./target.ts";

/** Registers target-prefixed integration tests while keeping scenario bodies shared. */
export function registerFeatureSuite(
  target: IntegrationTarget,
  scenarios: readonly IntegrationScenario[],
): void {
  for (const scenario of scenarios) {
    Deno.test({
      name: `${target.id}: ${scenario.name}`,
      ignore: target.ignore,
      sanitizeResources: false,
      sanitizeOps: false,
      fn: async () => {
        await scenario.run(target);
      },
    });
  }
}
