/**
 * MariaDB feature/compatibility suite for `@sisal/mysql` — the same adapter
 * and shared scenario list as the MySQL suite, run against a MariaDB server:
 * the auto-detected identity lights `INSERT`/`DELETE … RETURNING`, and JSON
 * values read back as text (`LONGTEXT` alias).
 *
 * @module
 */
import { registerFeatureSuite } from "./_shared/register.ts";
import { featureScenariosFor } from "./_shared/scenarios.ts";
import { mariadbTarget } from "./_targets/mariadb.ts";

registerFeatureSuite(mariadbTarget, featureScenariosFor(mariadbTarget));
