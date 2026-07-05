/**
 * Shared fixtures for Drizzle ORM 0.45.2 parity tests for `@sisal/orm`.
 *
 * These tests pin Sisal's public surface against the equivalent Drizzle 0.45.2
 * surface. They cover both parity guardrails and known roadmap divergences.
 *
 * See ../../../docs/drizzle-parity.md for the human-readable matrix and
 * roadmap.
 */
import * as orm from "../../mod.ts";
import {
  columns,
  type Condition,
  createDatabase,
  defineTable,
  renderSql,
  type SqlDialect,
  toSql,
} from "../../mod.ts";

// Cast for "is this Drizzle name absent?" checks without compile errors.
export const api = orm as unknown as Record<string, unknown>;

export const users = defineTable("users", {
  id: columns.integer().primaryKey(),
  name: columns.text().notNull(),
  age: columns.integer().optional(),
}, { naming: "preserve" });

export const db = createDatabase({ dialect: "postgres" });

export function render(
  condition: Condition,
  dialect: SqlDialect = "postgres",
) {
  return renderSql(toSql(condition), { dialect });
}
