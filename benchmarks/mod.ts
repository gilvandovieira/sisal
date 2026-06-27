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
import { migrateCliScenarios } from "./scenarios/migrate_cli.ts";

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

registerBenchmarkScenarios(migrateCliScenarios);
