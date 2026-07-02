/**
 * Smoke test: the extracted `@sisal/core` surface renders SQL end-to-end on
 * its own — schema definition, operators, capability predicate, and the
 * dialect renderer, with no `@sisal/orm` involvement.
 */
import { assert, assertEquals } from "@std/assert";
import {
  CAPABILITY_TARGETS,
  capabilitySupported,
  columns,
  createSchemaSnapshot,
  defineTable,
  DIALECT_CAPABILITIES,
  eq,
  renderSql,
  SCHEMA_SNAPSHOT_VERSION,
  sql,
} from "./mod.ts";

Deno.test("core: fragment IR renders per dialect without the ORM", () => {
  const posts = defineTable("posts", {
    id: columns.integer().primaryKey(),
    hotScore: columns.integer().notNull().default(0),
  });
  const condition = eq(posts.columns.hotScore, 5);
  const fragment = sql`select * from posts where ${condition.sql}`;
  assertEquals(
    renderSql(fragment, { dialect: "postgres" }).text,
    'select * from posts where "posts"."hot_score" = $1',
  );
  assertEquals(
    renderSql(fragment, { dialect: "mysql" }).text,
    "select * from posts where `posts`.`hot_score` = ?",
  );
});

Deno.test("core: snapshot + capability registry are self-contained", () => {
  const users = defineTable("users", {
    id: columns.integer().primaryKey(),
  });
  const snapshot = createSchemaSnapshot({
    dialect: "postgres",
    tables: [users],
  });
  assertEquals(snapshot.version, SCHEMA_SNAPSHOT_VERSION);
  assert(
    capabilitySupported(
      DIALECT_CAPABILITIES.distinctOn,
      CAPABILITY_TARGETS.pg,
    ),
  );
  assert(
    !capabilitySupported(
      DIALECT_CAPABILITIES.distinctOn,
      CAPABILITY_TARGETS.mysql,
    ),
  );
});
