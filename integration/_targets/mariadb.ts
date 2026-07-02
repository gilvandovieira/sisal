import { makeMysqlFamilyTarget } from "./mysql_family.ts";

/**
 * MariaDB (Docker `mariadb:11`): the same adapter and scenario list as MySQL
 * proper, but the auto-detected identity lights `INSERT`/`DELETE …
 * RETURNING` (`UPDATE … RETURNING` stays guarded — its MariaDB floor is
 * 13.0), and `JSON` is a `LONGTEXT` alias, so JSON/array values read back as
 * strings.
 */
export const mariadbTarget = makeMysqlFamilyTarget({
  id: "mariadb",
  label: "MariaDB",
  urlEnv: "MARIADB_URL",
  gateEnv: "SISAL_MARIADB_IT",
  returning: true,
  json: "text",
  array: "jsonText",
});
