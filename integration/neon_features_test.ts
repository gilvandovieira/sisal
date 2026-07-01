/**
 * Neon (serverless PostgreSQL) feature/compatibility suite for `@sisal/neon`.
 *
 * The scenario bodies live in `integration/_shared/`; this entrypoint keeps the
 * adapter-specific command, env gate, and `<adapter>:` test-name contract stable.
 *
 * @module
 */
import { registerFeatureSuite } from "./_shared/register.ts";
import { featureScenariosFor } from "./_shared/scenarios.ts";
import { neonTarget } from "./_targets/neon.ts";

registerFeatureSuite(neonTarget, featureScenariosFor(neonTarget));
