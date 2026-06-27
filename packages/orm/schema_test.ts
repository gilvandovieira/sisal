import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  assertValidSchemaSnapshot,
  defineSchemaSnapshot,
  deserializeSchemaSnapshot,
  diffSchemaSnapshots,
  equalSchemaSnapshots,
  isEmptySchemaSnapshotDiff,
  normalizeSchemaSnapshot,
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
): SisalSchemaSnapshot => ({ version: 1, tables });

Deno.test("@sisal/orm - canonical serialization round-trips and compares equal", () => {
  const snapshot: SisalSchemaSnapshot = {
    version: 1,
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
    version: 1,
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
    version: 1,
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

  assertEquals(snapshot.version, 1);
  assertEquals(snapshot.tables[0].name, "users");
  assertEquals(validateSchemaSnapshot(snapshot), []);
});

Deno.test("@sisal/orm - duplicate table detection", () => {
  const issues = validateSchemaSnapshot({
    version: 1,
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
    version: 1,
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
    version: 1,
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
    version: 1,
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
    version: 1,
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
    version: 1,
    tables: [
      {
        name: "b",
        columns: [{ name: "id", type: { kind: "text" } }],
        indexes: [{ name: "b_idx", columns: ["id"] }],
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
    version: 1,
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
      version: 2 as 1,
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
