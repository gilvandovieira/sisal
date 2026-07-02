/**
 * Benchmarks for core Sisal SQL rendering and schema snapshot creation.
 *
 * @module
 */

import {
  columns,
  createSchemaSnapshot,
  defineTable,
  renderSql,
  sql,
} from "@sisal/orm";
import { registerBenchmarkScenarios } from "./harness.ts";
import { advancedSqlScenarios } from "./scenarios/advanced_sql.ts";
import { drizzleProxyScenarios } from "./scenarios/drizzle_proxy.ts";
import { fakeDbProxyScenarios } from "./scenarios/fakedbproxy.ts";
import { migrateCliScenarios } from "./scenarios/migrate_cli.ts";
import { sqlGenerationScenarios } from "./scenarios/sql_generation.ts";
import { temporalScenarios } from "./scenarios/temporal.ts";
import { vsDrizzleScenarios } from "./scenarios/vs_drizzle.ts";
import { vsDrizzleExecuteScenarios } from "./scenarios/vs_drizzle_execute.ts";

const users = defineTable("users", {
  id: columns.uuid().primaryKey(),
  email: columns.text().notNull(),
});

Deno.bench("render parameterized sql", () => {
  renderSql(sql`select * from users where id = ${"u_1"}`, {
    dialect: "postgres",
  });
});

Deno.bench("create schema snapshot", () => {
  createSchemaSnapshot({ tables: [users] });
});

registerBenchmarkScenarios(advancedSqlScenarios);
registerBenchmarkScenarios(migrateCliScenarios);
registerBenchmarkScenarios(fakeDbProxyScenarios);
registerBenchmarkScenarios(drizzleProxyScenarios);
registerBenchmarkScenarios(sqlGenerationScenarios);
registerBenchmarkScenarios(temporalScenarios);
registerBenchmarkScenarios(vsDrizzleScenarios);
registerBenchmarkScenarios(vsDrizzleExecuteScenarios);
