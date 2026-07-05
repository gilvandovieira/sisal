import { assertEquals, assertThrows } from "@std/assert";
import { OrmError, type SisalSchemaSnapshot } from "@sisal/orm";
import {
  generateMysqlAddColumn,
  generateMysqlCreateTable,
  generateMysqlIndexes,
  generateMysqlUpStatements,
  quoteMysqlIdent,
} from "../../src/migrate/ddl.ts";

type TableSnapshot = SisalSchemaSnapshot["tables"][number];

const emptySnapshot: SisalSchemaSnapshot = { version: 2, tables: [] };

function snapshotOf(...tables: TableSnapshot[]): SisalSchemaSnapshot {
  return { version: 2, tables };
}

Deno.test("@sisal/mysql - quotes identifiers with backticks, escaping embedded backticks", () => {
  assertEquals(quoteMysqlIdent("users"), "`users`");
  assertEquals(quoteMysqlIdent("a`b"), "`a``b`");
});

Deno.test("@sisal/mysql - maps the full C4 type table in CREATE TABLE", () => {
  const kitchenSink: TableSnapshot = {
    name: "kitchen_sink",
    columns: [
      { name: "id", type: { kind: "bigserial" }, nullable: false },
      { name: "body", type: { kind: "text" } },
      { name: "title", type: { kind: "varchar", length: 320 } },
      { name: "slug", type: { kind: "varchar" } },
      { name: "code", type: { kind: "char", length: 2 } },
      { name: "count", type: { kind: "integer" } },
      { name: "small", type: { kind: "smallint" } },
      { name: "big", type: { kind: "bigint" } },
      { name: "price", type: { kind: "numeric", precision: 10, scale: 2 } },
      { name: "ratio", type: { kind: "real" } },
      { name: "score", type: { kind: "double" } },
      { name: "active", type: { kind: "boolean" } },
      { name: "meta", type: { kind: "json" } },
      { name: "meta_b", type: { kind: "jsonb" } },
      { name: "born", type: { kind: "date" } },
      { name: "at", type: { kind: "time" } },
      { name: "created", type: { kind: "timestamp" } },
      { name: "seen", type: { kind: "timestamptz" } },
      { name: "token", type: { kind: "uuid" } },
      { name: "payload", type: { kind: "bytea" } },
      { name: "tags", type: { kind: "text", array: true } },
      { name: "custom", type: { kind: "text", dialectType: "MEDIUMTEXT" } },
    ],
    primaryKey: { columns: ["id"] },
  };

  assertEquals(
    generateMysqlCreateTable(kitchenSink),
    "CREATE TABLE `kitchen_sink` (\n" +
      "  `id` BIGINT NOT NULL AUTO_INCREMENT,\n" +
      "  `body` TEXT,\n" +
      "  `title` VARCHAR(320),\n" +
      "  `slug` VARCHAR(255),\n" +
      "  `code` CHAR(2),\n" +
      "  `count` INT,\n" +
      "  `small` SMALLINT,\n" +
      "  `big` BIGINT,\n" +
      "  `price` DECIMAL(10, 2),\n" +
      "  `ratio` FLOAT,\n" +
      "  `score` DOUBLE,\n" +
      "  `active` BOOLEAN,\n" +
      "  `meta` JSON,\n" +
      "  `meta_b` JSON,\n" +
      "  `born` DATE,\n" +
      "  `at` TIME(6),\n" +
      "  `created` DATETIME(6),\n" +
      "  `seen` TIMESTAMP(6) NULL,\n" +
      "  `token` CHAR(36),\n" +
      "  `payload` LONGBLOB,\n" +
      "  `tags` JSON,\n" +
      "  `custom` MEDIUMTEXT,\n" +
      "  PRIMARY KEY (`id`)\n" +
      ");",
  );
});

Deno.test("@sisal/mysql - timestamptz is explicit NULL only when nullable", () => {
  const table: TableSnapshot = {
    name: "events",
    columns: [
      { name: "id", type: { kind: "integer" }, nullable: false },
      { name: "seen", type: { kind: "timestamptz" }, nullable: false },
    ],
    primaryKey: { columns: ["id"] },
  };
  assertEquals(
    generateMysqlCreateTable(table),
    "CREATE TABLE `events` (\n" +
      "  `id` INT NOT NULL,\n" +
      "  `seen` TIMESTAMP(6) NOT NULL,\n" +
      "  PRIMARY KEY (`id`)\n" +
      ");",
  );
});

Deno.test("@sisal/mysql - emits STORED and VIRTUAL generated columns", () => {
  const table: TableSnapshot = {
    name: "docs",
    columns: [
      { name: "id", type: { kind: "integer" }, nullable: false },
      { name: "payload", type: { kind: "json" }, nullable: false },
      {
        name: "title",
        type: { kind: "varchar", length: 255 },
        generatedAs: {
          sql: "json_unquote(json_extract(payload, '$.title'))",
          stored: true,
        },
      },
      {
        name: "upper",
        type: { kind: "varchar", length: 255 },
        generatedAs: { sql: "upper(title)", stored: false },
      },
    ],
    primaryKey: { columns: ["id"] },
  };
  assertEquals(
    generateMysqlCreateTable(table),
    "CREATE TABLE `docs` (\n" +
      "  `id` INT NOT NULL,\n" +
      "  `payload` JSON NOT NULL,\n" +
      "  `title` VARCHAR(255) GENERATED ALWAYS AS " +
      "(json_unquote(json_extract(payload, '$.title'))) STORED,\n" +
      "  `upper` VARCHAR(255) GENERATED ALWAYS AS (upper(title)) VIRTUAL,\n" +
      "  PRIMARY KEY (`id`)\n" +
      ");",
  );
});

Deno.test("@sisal/mysql - defaults: plain literals, boolean 0/1, paren expressions, paren literals on TEXT/JSON", () => {
  const table: TableSnapshot = {
    name: "defaults",
    columns: [
      {
        name: "id",
        type: { kind: "uuid" },
        nullable: false,
        default: { kind: "expression", sql: "uuid()" },
      },
      {
        name: "count",
        type: { kind: "integer" },
        default: { kind: "literal", value: 0 },
      },
      {
        name: "label",
        type: { kind: "varchar", length: 40 },
        default: { kind: "literal", value: "it's new" },
      },
      {
        name: "active",
        type: { kind: "boolean" },
        default: { kind: "literal", value: true },
      },
      {
        name: "meta",
        type: { kind: "json" },
        default: { kind: "literal", value: "{}" },
      },
      {
        name: "body",
        type: { kind: "text" },
        default: { kind: "literal", value: "empty" },
      },
    ],
    primaryKey: { columns: ["id"] },
  };

  assertEquals(
    generateMysqlCreateTable(table),
    "CREATE TABLE `defaults` (\n" +
      "  `id` CHAR(36) NOT NULL DEFAULT (uuid()),\n" +
      "  `count` INT DEFAULT 0,\n" +
      "  `label` VARCHAR(40) DEFAULT 'it''s new',\n" +
      "  `active` BOOLEAN DEFAULT 1,\n" +
      "  `meta` JSON DEFAULT ('{}'),\n" +
      "  `body` TEXT DEFAULT ('empty'),\n" +
      "  PRIMARY KEY (`id`)\n" +
      ");",
  );
});

Deno.test("@sisal/mysql - serial must lead a key, at most one per table, never via ADD COLUMN", () => {
  const keyless: TableSnapshot = {
    name: "keyless",
    columns: [{ name: "id", type: { kind: "serial" }, nullable: false }],
  };
  assertThrows(
    () => generateMysqlCreateTable(keyless),
    OrmError,
    "does not lead a key",
  );

  const trailing: TableSnapshot = {
    name: "trailing",
    columns: [
      { name: "region", type: { kind: "integer" }, nullable: false },
      { name: "id", type: { kind: "serial" }, nullable: false },
    ],
    primaryKey: { columns: ["region", "id"] },
  };
  assertThrows(
    () => generateMysqlCreateTable(trailing),
    OrmError,
    "does not lead a key",
  );

  // A secondary index leading with the column satisfies InnoDB.
  const indexed: TableSnapshot = {
    ...trailing,
    name: "indexed",
    indexes: [{ columns: [{ value: "id" }] }],
  };
  assertEquals(
    generateMysqlCreateTable(indexed).includes("AUTO_INCREMENT"),
    true,
  );

  const twoSerials: TableSnapshot = {
    name: "two_serials",
    columns: [
      { name: "a", type: { kind: "serial" }, nullable: false },
      { name: "b", type: { kind: "bigserial" }, nullable: false },
    ],
    primaryKey: { columns: ["a"] },
  };
  assertThrows(
    () => generateMysqlCreateTable(twoSerials),
    OrmError,
    "at most one AUTO_INCREMENT",
  );

  assertThrows(
    () =>
      generateMysqlAddColumn({ name: "users" }, {
        name: "id",
        type: { kind: "serial" },
        nullable: false,
      }),
    OrmError,
    "ADD COLUMN",
  );
});

Deno.test("@sisal/mysql - TEXT/BLOB/JSON columns cannot be keys", () => {
  const textPk: TableSnapshot = {
    name: "text_pk",
    columns: [{ name: "slug", type: { kind: "text" }, nullable: false }],
    primaryKey: { columns: ["slug"] },
  };
  assertThrows(
    () => generateMysqlCreateTable(textPk),
    OrmError,
    "use varchar(n) instead",
  );

  const jsonIndex: TableSnapshot = {
    name: "json_index",
    columns: [
      { name: "id", type: { kind: "integer" }, nullable: false },
      { name: "meta", type: { kind: "json" } },
    ],
    primaryKey: { columns: ["id"] },
    indexes: [{ columns: [{ value: "meta" }] }],
  };
  assertThrows(
    () => generateMysqlCreateTable(jsonIndex),
    OrmError,
    "maps to JSON",
  );

  // A dialectType that is not TEXT-mapped stays keyable.
  const varcharOverride: TableSnapshot = {
    name: "override",
    columns: [{
      name: "slug",
      type: { kind: "text", dialectType: "VARCHAR(191)" },
      nullable: false,
    }],
    primaryKey: { columns: ["slug"] },
  };
  assertEquals(
    generateMysqlCreateTable(varcharOverride).includes("VARCHAR(191)"),
    true,
  );
});

Deno.test("@sisal/mysql - indexes: DESC renders, partial and expression indexes throw", () => {
  const table: TableSnapshot = {
    name: "posts",
    columns: [
      { name: "id", type: { kind: "integer" }, nullable: false },
      { name: "score", type: { kind: "integer" } },
    ],
    primaryKey: { columns: ["id"] },
    indexes: [{
      name: "posts_score_desc",
      columns: [{ value: "score", direction: "desc" }],
    }],
  };
  assertEquals(generateMysqlIndexes(table), [
    "CREATE INDEX `posts_score_desc` ON `posts` (`score` DESC);",
  ]);

  assertThrows(
    () =>
      generateMysqlIndexes({
        ...table,
        indexes: [{ columns: [{ value: "score" }], where: "score > 0" }],
      }),
    OrmError,
    "partial indexes",
  );

  // Version-unknown (default identity) fails closed on functional indexes.
  assertThrows(
    () =>
      generateMysqlIndexes({
        ...table,
        indexes: [{ columns: [{ value: "lower(name)", expression: true }] }],
      }),
    OrmError,
    "functional (expression) index",
  );
});

Deno.test("@sisal/mysql - functional index lights on MySQL ≥ 8.0.13, rejected below + on MariaDB", () => {
  const table: TableSnapshot = {
    name: "posts",
    columns: [
      { name: "id", type: { kind: "integer" }, nullable: false },
      { name: "name", type: { kind: "text" } },
    ],
    primaryKey: { columns: ["id"] },
    indexes: [{
      name: "posts_lower_name_idx",
      columns: [{ value: "lower(name)", expression: true }],
    }],
  };

  // Base MySQL ≥ 8.0.13: emitted as a functional key part (double parens).
  assertEquals(
    generateMysqlIndexes(table, { dialect: "mysql", version: "8.0.16" }),
    ["CREATE INDEX `posts_lower_name_idx` ON `posts` ((lower(name)));"],
  );

  // Below the floor, MariaDB (any version), and unknown version fail closed.
  for (
    const identity of [
      { dialect: "mysql", version: "8.0.10" },
      { dialect: "mysql", variant: "mariadb", version: "11.8.8" },
      { dialect: "mysql" },
    ] as const
  ) {
    assertThrows(
      () => generateMysqlIndexes(table, identity),
      OrmError,
      "functional (expression) index",
    );
  }
});

Deno.test("@sisal/mysql - foreign keys emit table-level after every CREATE TABLE", () => {
  const to = snapshotOf(
    {
      name: "comments",
      columns: [
        { name: "id", type: { kind: "serial" }, nullable: false },
        { name: "post_id", type: { kind: "integer" }, nullable: false },
      ],
      primaryKey: { columns: ["id"] },
      foreignKeys: [{
        columns: ["post_id"],
        references: { table: "posts", columns: ["id"] },
        onDelete: "cascade",
      }],
    },
    {
      name: "posts",
      columns: [{ name: "id", type: { kind: "integer" }, nullable: false }],
      primaryKey: { columns: ["id"] },
    },
  );

  const plan = generateMysqlUpStatements(to);

  assertEquals(plan.destructive, []);
  assertEquals(plan.statements, [
    "CREATE TABLE `comments` (\n" +
    "  `id` INT NOT NULL AUTO_INCREMENT,\n" +
    "  `post_id` INT NOT NULL,\n" +
    "  PRIMARY KEY (`id`)\n" +
    ");",
    "CREATE TABLE `posts` (\n" +
    "  `id` INT NOT NULL,\n" +
    "  PRIMARY KEY (`id`)\n" +
    ");",
    "ALTER TABLE `comments` ADD FOREIGN KEY (`post_id`) REFERENCES `posts` (`id`) ON DELETE CASCADE;",
  ]);
});

Deno.test("@sisal/mysql - checks and named unique constraints render in CREATE TABLE", () => {
  const table: TableSnapshot = {
    name: "accounts",
    columns: [
      { name: "id", type: { kind: "integer" }, nullable: false },
      { name: "email", type: { kind: "varchar", length: 320 } },
      { name: "balance", type: { kind: "integer" } },
    ],
    primaryKey: { columns: ["id"] },
    uniqueConstraints: [{ name: "accounts_email_key", columns: ["email"] }],
    checks: [{ name: "balance_positive", expression: "balance >= 0" }],
  };
  assertEquals(
    generateMysqlCreateTable(table),
    "CREATE TABLE `accounts` (\n" +
      "  `id` INT NOT NULL,\n" +
      "  `email` VARCHAR(320),\n" +
      "  `balance` INT,\n" +
      "  PRIMARY KEY (`id`),\n" +
      "  CONSTRAINT `accounts_email_key` UNIQUE (`email`),\n" +
      "  CONSTRAINT `balance_positive` CHECK (balance >= 0)\n" +
      ");",
  );
});

Deno.test("@sisal/mysql - generates additive migration SQL and withholds destructive changes", () => {
  const from = snapshotOf({
    name: "users",
    columns: [
      { name: "id", type: { kind: "integer" }, nullable: false },
      { name: "legacy", type: { kind: "text" } },
    ],
    primaryKey: { columns: ["id"] },
  });
  const to = snapshotOf({
    name: "users",
    columns: [
      { name: "id", type: { kind: "integer" }, nullable: false },
      { name: "email", type: { kind: "varchar", length: 320 } },
    ],
    primaryKey: { columns: ["id"] },
  });

  const plan = generateMysqlUpStatements(to, from);

  assertEquals(plan.statements, [
    "ALTER TABLE `users` ADD COLUMN `email` VARCHAR(320);",
  ]);
  assertEquals(plan.destructive.length, 1);
});

Deno.test("@sisal/mysql - emits mysql-dialect and agnostic schema objects, skips other dialects", () => {
  const to: SisalSchemaSnapshot = {
    ...emptySnapshot,
    schemaObjects: [
      {
        kind: "view",
        name: "everywhere",
        up: "CREATE VIEW everywhere AS SELECT 1;",
      },
      {
        kind: "view",
        name: "mysql_only",
        dialect: "mysql",
        up: "CREATE VIEW mysql_only AS SELECT 2;",
      },
      {
        kind: "view",
        name: "pg_only",
        dialect: "postgres",
        up: "CREATE VIEW pg_only AS SELECT 3;",
      },
    ],
  };

  assertEquals(generateMysqlUpStatements(to, emptySnapshot).statements, [
    "CREATE VIEW everywhere AS SELECT 1;",
    "CREATE VIEW mysql_only AS SELECT 2;",
  ]);
});

Deno.test("@sisal/mysql - qualifies schema-scoped tables as database qualifiers", () => {
  const table: TableSnapshot = {
    name: "users",
    schema: "analytics",
    columns: [{ name: "id", type: { kind: "integer" }, nullable: false }],
    primaryKey: { columns: ["id"] },
  };
  assertEquals(
    generateMysqlCreateTable(table).startsWith(
      "CREATE TABLE `analytics`.`users` (",
    ),
    true,
  );
});
