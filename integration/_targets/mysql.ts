import { makeMysqlFamilyTarget } from "./mysql_family.ts";

/**
 * MySQL proper (Docker `mysql:8.4`): no `RETURNING` at all — the insert
 * scenario exercises the B7 fetch-by-key strategy — and `JSON` columns read
 * back parsed.
 */
export const mysqlTarget = makeMysqlFamilyTarget({
  id: "mysql",
  label: "MySQL",
  urlEnv: "MYSQL_URL",
  gateEnv: "SISAL_MYSQL_IT",
  returning: false,
  json: "parsed",
  array: "jsonParsed",
});
