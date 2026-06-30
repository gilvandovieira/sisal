import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  assertValidSchemaSnapshot,
  defineSchemaObject,
  defineSchemaSnapshot,
  deserializeSchemaSnapshot,
  diffSchemaSnapshots,
  equalSchemaSnapshots,
  isEmptySchemaSnapshotDiff,
  normalizeSchemaSnapshot,
  schemaObjectDropStatements,
  selectSchemaObjects,
  serializeSchemaSnapshot,
  type SisalColumnSnapshot,
  type SisalSchemaSnapshot,
  validateSchemaSnapshot,
} from "./mod.ts";

const textColumn = (name: string): SisalColumnSnapshot => ({
  name,
  type: { kind: "text" },
});

const snapshotOf = (
  tables: SisalSchemaSnapshot["tables"],
): SisalSchemaSnapshot => ({ version: 2, tables });

Deno.test("@sisal/orm - canonical serialization round-trips and compares equal", () => {
  const snapshot: SisalSchemaSnapshot = {
    version: 2,
    dialect: "postgres",
    tables: [
      {
        name: "b_table",
        columns: [{ name: "id", type: { kind: "uuid" }, nullable: false }],
      },
      {
        name: "a_table",
        columns: [{ name: "id", type: { kind: "uuid" }, nullable: false }],
      },
    ],
  };

  // Same tables in a different order are structurally equal after normalization.
  const reordered: SisalSchemaSnapshot = {
    version: 2,
    dialect: "postgres",
    tables: [snapshot.tables[1], snapshot.tables[0]],
  };

  const json = serializeSchemaSnapshot(snapshot);
  assertEquals(
    deserializeSchemaSnapshot(json),
    normalizeSchemaSnapshot(snapshot),
  );
  assertEquals(equalSchemaSnapshots(snapshot, reordered), true);

  assertThrows(() => deserializeSchemaSnapshot("{not valid json"));
});

Deno.test("@sisal/orm - valid minimal snapshot", () => {
  const snapshot = defineSchemaSnapshot({
    version: 2,
    dialect: "postgres",
    tables: [
      {
        name: "users",
        columns: [
          { name: "id", type: { kind: "uuid" }, nullable: false },
        ],
        primaryKey: { columns: ["id"] },
      },
    ],
  });

  assertEquals(snapshot.version, 2);
  assertEquals(snapshot.tables[0].name, "users");
  assertEquals(validateSchemaSnapshot(snapshot), []);
});

Deno.test("@sisal/orm - duplicate table detection", () => {
  const issues = validateSchemaSnapshot({
    version: 2,
    tables: [
      { name: "users", columns: [{ name: "id", type: { kind: "text" } }] },
      { name: "users", columns: [{ name: "id", type: { kind: "text" } }] },
    ],
  });

  assertEquals(
    issues.some((issue) => issue.code === "SCHEMA_DUPLICATE_TABLE"),
    true,
  );
});

Deno.test("@sisal/orm - duplicate column detection", () => {
  const issues = validateSchemaSnapshot({
    version: 2,
    tables: [
      {
        name: "users",
        columns: [
          { name: "id", type: { kind: "text" } },
          { name: "id", type: { kind: "uuid" } },
        ],
      },
    ],
  });

  assertEquals(
    issues.some((issue) => issue.code === "SCHEMA_DUPLICATE_COLUMN"),
    true,
  );
});

Deno.test("@sisal/orm - primary key references missing column", () => {
  const issues = validateSchemaSnapshot({
    version: 2,
    tables: [
      {
        name: "users",
        columns: [{ name: "id", type: { kind: "text" } }],
        primaryKey: { columns: ["missing"] },
      },
    ],
  });

  assertEquals(
    issues.some((issue) => issue.code === "SCHEMA_UNKNOWN_COLUMN"),
    true,
  );
});

Deno.test("@sisal/orm - foreign key references missing local column", () => {
  const issues = validateSchemaSnapshot({
    version: 2,
    tables: [
      {
        name: "posts",
        columns: [{ name: "id", type: { kind: "text" } }],
        foreignKeys: [
          {
            columns: ["userId"],
            references: { table: "users", columns: ["id"] },
          },
        ],
      },
    ],
  });

  assertEquals(
    issues.some((issue) => issue.code === "SCHEMA_UNKNOWN_COLUMN"),
    true,
  );
});

Deno.test("@sisal/orm - foreign key target checked when table exists", () => {
  const issues = validateSchemaSnapshot({
    version: 2,
    tables: [
      {
        name: "posts",
        columns: [
          { name: "id", type: { kind: "text" } },
          {
            name: "userId",
            type: { kind: "text" },
            references: { table: "users", column: "missing" },
          },
        ],
      },
      {
        name: "users",
        columns: [{ name: "id", type: { kind: "text" } }],
      },
    ],
  });

  assertEquals(
    issues.some((issue) => issue.code === "SCHEMA_UNKNOWN_TARGET"),
    true,
  );
});

Deno.test("@sisal/orm - normalization does not mutate input", () => {
  const input: SisalSchemaSnapshot = {
    version: 2,
    tables: [
      {
        name: "b",
        columns: [{ name: "id", type: { kind: "text" } }],
        indexes: [{ name: "b_idx", columns: [{ value: "id" }] }],
      },
      { name: "a", columns: [{ name: "id", type: { kind: "text" } }] },
    ],
  };
  const original = JSON.stringify(input);
  const normalized = normalizeSchemaSnapshot(input);

  assertEquals(JSON.stringify(input), original);
  assertEquals(normalized.tables.map((table) => table.name), ["a", "b"]);
  assertEquals(input.tables.map((table) => table.name), ["b", "a"]);
});

Deno.test("@sisal/orm - deterministic output order", () => {
  const snapshot = normalizeSchemaSnapshot({
    version: 2,
    tables: [
      { name: "z", columns: [{ name: "b", type: { kind: "text" } }] },
      {
        schema: "app",
        name: "a",
        columns: [{ name: "id", type: { kind: "uuid" } }],
      },
      { name: "a", columns: [{ name: "c", type: { kind: "text" } }] },
    ],
  });

  assertEquals(
    snapshot.tables.map((table) => `${table.schema ?? ""}.${table.name}`),
    [
      ".a",
      ".z",
      "app.a",
    ],
  );
});

Deno.test("@sisal/orm - assert throws structured issues", () => {
  assertThrows(() =>
    assertValidSchemaSnapshot({
      version: 1 as 2,
      tables: [{ name: "", columns: [] }],
    })
  );
});

Deno.test("@sisal/orm - diffSchemaSnapshots detects added/removed/changed tables", () => {
  const from = snapshotOf([
    { name: "users", columns: [textColumn("id"), textColumn("email")] },
    { name: "legacy", columns: [textColumn("id")] },
  ]);
  const to = snapshotOf([
    {
      name: "users",
      columns: [textColumn("id"), { name: "email", type: { kind: "varchar" } }],
    },
    { name: "posts", columns: [textColumn("id")] },
  ]);

  const diff = diffSchemaSnapshots(from, to);

  assertEquals(diff.addedTables.map((t) => t.name), ["posts"]);
  assertEquals(diff.removedTables.map((t) => t.name), ["legacy"]);
  assertEquals(diff.changedTables.map((t) => t.name), ["users"]);

  const usersDiff = diff.changedTables[0];
  assertEquals(usersDiff.columns.added, []);
  assertEquals(usersDiff.columns.removed, []);
  assertEquals(usersDiff.columns.changed.map((c) => c.name), ["email"]);
  assertEquals(usersDiff.columns.changed[0].from.type.kind, "text");
  assertEquals(usersDiff.columns.changed[0].to.type.kind, "varchar");
});

Deno.test("@sisal/orm - diffSchemaSnapshots reports column add/remove", () => {
  const from = snapshotOf([{ name: "t", columns: [textColumn("a")] }]);
  const to = snapshotOf([{
    name: "t",
    columns: [textColumn("a"), textColumn("b")],
  }]);

  const diff = diffSchemaSnapshots(from, to);
  const tableDiff = diff.changedTables[0];
  assertEquals(tableDiff.columns.added.map((c) => c.name), ["b"]);
  assertEquals(tableDiff.columns.removed, []);

  // The reverse direction reports the removal.
  const reverse = diffSchemaSnapshots(to, from);
  assertEquals(reverse.changedTables[0].columns.removed.map((c) => c.name), [
    "b",
  ]);
});

Deno.test("@sisal/orm - diff ignores ordering and reports empty for equal snapshots", () => {
  const a = snapshotOf([
    { name: "b", columns: [textColumn("y"), textColumn("x")] },
    { name: "a", columns: [textColumn("id")] },
  ]);
  // Same content, different table and column order.
  const b = snapshotOf([
    { name: "a", columns: [textColumn("id")] },
    { name: "b", columns: [textColumn("y"), textColumn("x")] },
  ]);

  const diff = diffSchemaSnapshots(a, b);
  assert(isEmptySchemaSnapshotDiff(diff));
  assertEquals(equalSchemaSnapshots(a, b), true);
});

Deno.test("@sisal/orm - defineSchemaObject drops empty optional fields", () => {
  const object = defineSchemaObject({
    name: "touch",
    kind: "function",
    up: "CREATE FUNCTION touch() RETURNS void AS $$ $$ LANGUAGE sql;",
  });
  assertEquals("dialect" in object, false);
  assertEquals("down" in object, false);
});

Deno.test("@sisal/orm - schemaObjects survive normalization in declared order", () => {
  const snapshot = normalizeSchemaSnapshot({
    version: 2,
    tables: [{ name: "a", columns: [textColumn("id")] }],
    schemaObjects: [
      { name: "second", kind: "raw", up: "SELECT 2;" },
      { name: "first", kind: "raw", up: "SELECT 1;" },
    ],
  });
  // Order is preserved (NOT sorted, unlike tables) — DDL dependencies matter.
  assertEquals(snapshot.schemaObjects?.map((o) => o.name), ["second", "first"]);
});

Deno.test("@sisal/orm - selectSchemaObjects gates by dialect and change", () => {
  const fn = "CREATE FUNCTION f() RETURNS void AS $$ $$ LANGUAGE sql;";
  const trig = "CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; END;";
  const to: SisalSchemaSnapshot = {
    version: 2,
    tables: [{ name: "a", columns: [textColumn("id")] }],
    schemaObjects: [
      { name: "f", kind: "function", dialect: "postgres", up: fn },
      { name: "t", kind: "trigger", dialect: "sqlite", up: trig },
      { name: "any", kind: "raw", up: "SELECT 1;" },
    ],
  };

  // Postgres sees its function + the dialect-agnostic object, not the trigger.
  assertEquals(
    selectSchemaObjects(to, undefined, "postgres").map((o) => o.name),
    ["f", "any"],
  );
  // Re-running against an identical `from` emits nothing for unchanged objects.
  assertEquals(selectSchemaObjects(to, to, "postgres"), []);
});

Deno.test("@sisal/orm - selectSchemaObjects re-emits a changed object body", () => {
  const base = {
    name: "f",
    kind: "function" as const,
    dialect: "postgres" as const,
  };
  const from: SisalSchemaSnapshot = {
    version: 2,
    tables: [],
    schemaObjects: [{ ...base, up: "CREATE FUNCTION f() v1" }],
  };
  const to: SisalSchemaSnapshot = {
    version: 2,
    tables: [],
    schemaObjects: [{ ...base, up: "CREATE FUNCTION f() v2" }],
  };

  assertEquals(
    selectSchemaObjects(to, from, "postgres").map((o) => o.up),
    ["CREATE FUNCTION f() v2"],
  );
});

Deno.test("@sisal/orm - schemaObjectDropStatements reverse declared order", () => {
  const snapshot: SisalSchemaSnapshot = {
    version: 2,
    tables: [],
    schemaObjects: [
      {
        name: "f",
        kind: "function",
        up: "CREATE ..1",
        down: "DROP FUNCTION f;",
      },
      { name: "t", kind: "trigger", up: "CREATE ..2", down: "DROP TRIGGER t;" },
      // No `down` → excluded from drop statements.
      { name: "v", kind: "view", up: "CREATE ..3" },
    ],
  };

  // Dependents (declared later) drop first.
  assertEquals(schemaObjectDropStatements(snapshot, "postgres"), [
    "DROP TRIGGER t;",
    "DROP FUNCTION f;",
  ]);
});
