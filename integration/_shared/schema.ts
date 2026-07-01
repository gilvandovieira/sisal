import { columns, defineTable } from "@sisal/orm";

/** Shared smoke schema used by future target harnesses. */
export function defineSharedSmokeSchema() {
  const orgs = defineTable("it_orgs", {
    id: columns.integer().primaryKey(),
    name: columns.text().notNull(),
  });
  const users = defineTable("it_users", {
    id: columns.integer().primaryKey(),
    email: columns.text().notNull(),
    name: columns.text(),
    age: columns.integer(),
    active: columns.boolean(),
    score: columns.numeric(10, 2),
    orgId: columns.integer(),
  });
  return { orgs, users };
}
