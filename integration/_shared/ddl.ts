import { createSchemaSnapshot, type TableDefinition } from "@sisal/orm";

import type { IntegrationTarget } from "./target.ts";

/** Generates and applies a target snapshot in declaration order. */
export async function applySnapshot(
  target: IntegrationTarget,
  tables: readonly TableDefinition[],
): Promise<void> {
  const { statements } = target.generateUp(
    createSchemaSnapshot({ dialect: target.snapshotDialect, tables }),
  );
  for (const statement of statements) {
    await (await target.db()).execute(statement);
  }
}
