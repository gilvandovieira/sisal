/**
 * libSQL / Turso feature/compatibility suite for `@sisal/libsql`.
 *
 * The scenario bodies live in `integration/_shared/`; this entrypoint keeps the
 * adapter-specific command, env gate, and `<adapter>:` test-name contract stable.
 *
 * @module
 */
import { registerFeatureSuite } from "./_shared/register.ts";
import { featureScenariosFor } from "./_shared/scenarios.ts";
import { libsqlTarget } from "./_targets/libsql.ts";

registerFeatureSuite(libsqlTarget, featureScenariosFor(libsqlTarget));
