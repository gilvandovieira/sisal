/**
 * MySQL feature/compatibility suite for `@sisal/mysql`.
 *
 * The scenario bodies live in `integration/_shared/`; this entrypoint keeps the
 * adapter-specific command, env gate, and `<adapter>:` test-name contract stable.
 *
 * @module
 */
import { registerFeatureSuite } from "./_shared/register.ts";
import { featureScenariosFor } from "./_shared/scenarios.ts";
import { mysqlTarget } from "./_targets/mysql.ts";

registerFeatureSuite(mysqlTarget, featureScenariosFor(mysqlTarget));
