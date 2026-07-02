import { makeMysqlFamilyTarget } from "./mysql_family.ts";

/**
 * MariaDB (Docker `mariadb:11`): the same adapter and scenario list as MySQL
 * proper, but the auto-detected identity lights `INSERT`/`DELETE …
 * RETURNING` (`UPDATE … RETURNING` stays guarded — its MariaDB floor is
 * 13.0), a `WITH` prefix on mutations is a typed guard (MariaDB parses
 * `WITH` only on `SELECT`), and `JSON` is a `LONGTEXT` alias, so JSON/array
 * values read back as strings.
 */
export const mariadbTarget = makeMysqlFamilyTarget({
  id: "mariadb",
  label: "MariaDB",
  urlEnv: "MARIADB_URL",
  gateEnv: "SISAL_MARIADB_IT",
  returning: true,
  mutationCte: false,
  json: "text",
  array: "jsonText",
});
