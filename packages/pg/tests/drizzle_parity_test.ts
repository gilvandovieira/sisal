/**
 * Drizzle ORM 0.45.2 parity tests for `@sisal/pg` DDL generation.
 *
 * Compares Sisal's pure Postgres DDL output against the equivalent
 * `drizzle-kit` generate shape (type mapping + CREATE TABLE). These tests are
 * connection-free — they never touch `@db/postgres`.
 *
 * See ../../docs/drizzle-parity.md (section 5).
 */
import { assert, assertEquals } from "@std/assert";
import {
  asc,
  check,
  columns,
  createSchemaSnapshot,
  defineTable,
  desc,
  index,
  primaryKey,
  sql,
  unique,
  uniqueIndex,
} from "@sisal/orm";
import {
  generatePostgresColumnType,
  generatePostgresUpStatements,
} from "../src/migrate/ddl.ts";

Deno.test("parity: table extras — composite PK, named unique, check, indexes", () => {
  const members = defineTable("members", {
    orgId: columns.integer(),
    userId: columns.integer(),
    email: columns.text().notNull(),
    age: columns.integer(),
  }, (t) => [
    primaryKey({ columns: [t.orgId, t.userId] }),
    unique("uq_email").on(t.email),
    check("age_check", sql`${t.age} >= 0`),
    index("members_email_idx").on(t.email),
    uniqueIndex().on(t.email, t.orgId),
  ], { naming: "preserve" });
  const { statements } = generatePostgresUpStatements(
    createSchemaSnapshot({ dialect: "postgres", tables: [members] }),
  );
  const create = statements.find((s) => s.startsWith("CREATE TABLE"))!;

  assert(create.includes('PRIMARY KEY ("orgId", "userId")'), create);
  assert(create.includes('CONSTRAINT "uq_email" UNIQUE ("email")'), create);
  // CHECK references the column unqualified (portable across dialects).
  assert(create.includes('CONSTRAINT "age_check" CHECK ("age" >= 0)'), create);
  // Indexes are separate CREATE INDEX statements (auto-named when unnamed).
  assert(
    statements.includes(
      'CREATE INDEX "members_email_idx" ON "members" ("email");',
    ),
  );
  assert(
    statements.includes(
      'CREATE UNIQUE INDEX "members_email_orgId_idx" ON "members" ' +
        '("email", "orgId");',
    ),
  );
});

Deno.test("parity: rich indexes — direction, partial WHERE, expression keys", () => {
  const posts = defineTable("posts", {
    id: columns.integer(),
    status: columns.text(),
    hotScore: columns.integer(),
    createdAt: columns.timestamp(),
    email: columns.text(),
  }, (t) => [
    // DESC keyset ordering + a partial-index predicate.
    index("hot_feed")
      .where(sql`${t.status} = 'published'`)
      .on(desc(t.hotScore), desc(t.createdAt), desc(t.id)),
    // Mixed direction.
    index("new_feed").on(asc(t.createdAt), desc(t.id)),
    // Expression index key.
    uniqueIndex("lower_email").on(sql`lower(${t.email})`),
  ], { naming: "preserve" });
  const { statements } = generatePostgresUpStatements(
    createSchemaSnapshot({ dialect: "postgres", tables: [posts] }),
  );
  const all = statements.join("\n");

  assert(
    statements.includes(
      'CREATE INDEX "hot_feed" ON "posts" ' +
        '("hotScore" DESC, "createdAt" DESC, "id" DESC) ' +
        `WHERE "status" = 'published';`,
    ),
    all,
  );
  assert(
    statements.includes(
      'CREATE INDEX "new_feed" ON "posts" ("createdAt" ASC, "id" DESC);',
    ),
    all,
  );
  assert(
    statements.includes(
      'CREATE UNIQUE INDEX "lower_email" ON "posts" ((lower("email")));',
    ),
    all,
  );
});

Deno.test("parity: Postgres column type mapping mirrors drizzle pg-core", () => {
  assertEquals(generatePostgresColumnType({ kind: "uuid" }), "uuid");
  assertEquals(
    generatePostgresColumnType({ kind: "varchar", length: 255 }),
    "varchar(255)",
  );
  assertEquals(generatePostgresColumnType({ kind: "integer" }), "integer");
  assertEquals(generatePostgresColumnType({ kind: "boolean" }), "boolean");
  assertEquals(generatePostgresColumnType({ kind: "jsonb" }), "jsonb");
  assertEquals(
    generatePostgresColumnType({ kind: "timestamp" }),
    "timestamp",
  );
  assertEquals(
    generatePostgresColumnType({ kind: "timestamptz" }),
    "timestamptz",
  );
  assertEquals(generatePostgresColumnType({ kind: "time" }), "time");
  assertEquals(generatePostgresColumnType({ kind: "bytea" }), "bytea");
  assertEquals(
    generatePostgresColumnType({ kind: "text", array: true }),
    "text[]",
  );
  for (
    const [type, ddl] of [
      [{ kind: "enum", dialectType: "post_status" }, "post_status"],
      [{ kind: "interval", dialectType: "interval" }, "interval"],
      [{ kind: "point", dialectType: "point" }, "point"],
      [
        { kind: "geometry", dialectType: "geometry(Point,4326)" },
        "geometry(Point,4326)",
      ],
      [{ kind: "inet", dialectType: "inet" }, "inet"],
      [{ kind: "vector", dialectType: "vector(3)" }, "vector(3)"],
      [{ kind: "bit", dialectType: "bit(8)" }, "bit(8)"],
      [{ kind: "money", dialectType: "money" }, "money"],
      [
        {
          kind: "integer",
          dialectType: "integer generated always as identity",
        },
        "integer generated always as identity",
      ],
    ] as const
  ) {
    assertEquals(generatePostgresColumnType(type), ddl);
  }
  assertEquals(
    generatePostgresColumnType({
      kind: "vector",
      dialectType: "vector(3)",
      array: true,
    }),
    "vector(3)[]",
  );
});

Deno.test("parity: defineTable -> Postgres CREATE TABLE", () => {
  const users = defineTable("users", {
    id: columns.uuid().primaryKey(),
    email: columns.varchar(255).notNull().unique(),
  });
  const snapshot = createSchemaSnapshot({
    dialect: "postgres",
    tables: [users],
  });
  const { statements } = generatePostgresUpStatements(snapshot);

  assertEquals(statements, [
    'CREATE TABLE "users" (\n' +
    '  "id" uuid NOT NULL,\n' +
    '  "email" varchar(255) NOT NULL,\n' +
    '  PRIMARY KEY ("id"),\n' +
    '  UNIQUE ("email")\n' +
    ");",
  ]);
});

Deno.test("parity: foreign keys + actions emit as ALTER after CREATE", () => {
  const orgs = defineTable("orgs", { id: columns.uuid().primaryKey() });
  const users = defineTable("users", {
    id: columns.uuid().primaryKey(),
    orgId: columns.uuid().references("orgs", "id", {
      onDelete: "cascade",
      onUpdate: "restrict",
    }),
  }, { naming: "preserve" });
  const { statements } = generatePostgresUpStatements(
    createSchemaSnapshot({ dialect: "postgres", tables: [orgs, users] }),
  );

  // Foreign keys are added after every CREATE TABLE (forward-reference safe).
  assertEquals(
    statements.at(-1),
    'ALTER TABLE "users" ADD FOREIGN KEY ("orgId") REFERENCES "orgs" ("id") ' +
      "ON DELETE CASCADE ON UPDATE RESTRICT;",
  );
});
