import { mysqlFamilyScenarios } from "./mysql_family_scenarios.ts";
import { postgresFamilyScenarios } from "./postgres_family_scenarios.ts";
import { sqliteFamilyScenarios } from "./sqlite_family_scenarios.ts";
import type {
  IntegrationAdapterId,
  IntegrationFamily,
  IntegrationScenario,
  IntegrationTarget,
} from "./target.ts";

export function featureScenariosFor(
  target: IntegrationTarget,
): readonly IntegrationScenario[] {
  return featureScenariosForFamily(target.family);
}

export function featureScenariosForAdapter(
  adapter: IntegrationAdapterId,
): readonly IntegrationScenario[] {
  switch (adapter) {
    case "pg":
    case "neon":
      return postgresFamilyScenarios();
    case "sqlite":
    case "libsql":
      return sqliteFamilyScenarios();
    case "mysql":
    case "mariadb":
      return mysqlFamilyScenarios();
  }
}

export function featureScenariosForFamily(
  family: IntegrationFamily,
): readonly IntegrationScenario[] {
  switch (family) {
    case "postgres":
      return postgresFamilyScenarios();
    case "sqlite":
      return sqliteFamilyScenarios();
    case "mysql":
      return mysqlFamilyScenarios();
  }
}
