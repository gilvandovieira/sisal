import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  type AppliedMigration,
  assertMigrationChecksum,
  buildMigrationFile,
  calculateMigrationChecksum,
  checkDrift,
  createAppliedMigration,
  createMigrationPlan,
  createMigrator,
  defineConfig,
  defineMigration,
  defineSchemaMigrationPlan,
  defineSqlMigration,
  formatMigrationFilename,
  getAppliedMigrations,
  getPendingMigrations,
  getRollbackMigrations,
  memoryMigrationStore,
  type MigrationDriver,
  MigrationError,
  type MigrationFileSystem,
  type MigrationStore,
  type MigrationTransaction,
  nextMigrationSequence,
  noopMigrationDriver,
  noopMigrator,
  parseMigrationSequence,
  planSchemaChanges,
  readMigrationsDir,
  slugifyMigrationName,
  sortMigrations,
  validateMigration,
  validateMigrations,
  writeMigrationFile,
} from "./mod.ts";
import type { SisalSchemaSnapshot } from "@sisal/core";

/** In-memory MigrationFileSystem for tests. */
function fakeFs(): MigrationFileSystem & {
  readonly files: Map<string, string>;
} {
  const files = new Map<string, string>();
  return {
    files,
    readDir(path: string): Promise<readonly string[]> {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          if (!rest.includes("/")) {
            names.add(rest);
          }
        }
      }
      return Promise.resolve([...names]);
    },
    readFile(path: string): Promise<string | undefined> {
      return Promise.resolve(files.get(path));
    },
    writeFile(path: string, content: string): Promise<void> {
      files.set(path, content);
      return Promise.resolve();
    },
    mkdir(): Promise<void> {
      return Promise.resolve();
    },
  };
}

function recordingMigrationStore(): {
  readonly store: MigrationStore;
  readonly marked: AppliedMigration[];
} {
  const applied: AppliedMigration[] = [];
  const marked: AppliedMigration[] = [];

  return {
    marked,
    store: {
      listApplied(): Promise<AppliedMigration[]> {
        return Promise.resolve([...applied]);
      },

      getApplied(id): Promise<AppliedMigration | undefined> {
        return Promise.resolve(
          applied.find((migration) => migration.id === id),
        );
      },

      markApplied(migration): Promise<void> {
        marked.push(migration);
        applied.push(migration);
        return Promise.resolve();
      },

      unmarkApplied(id): Promise<boolean> {
        const index = applied.findIndex((migration) => migration.id === id);

        if (index < 0) {
          return Promise.resolve(false);
        }

        applied.splice(index, 1);
        return Promise.resolve(true);
      },
    },
  };
}

const snapshot = (
  tables: SisalSchemaSnapshot["tables"],
): SisalSchemaSnapshot => ({ version: 2, tables });

Deno.test("@sisal/migrate - checksum ignores line-ending and trailing-whitespace differences", () => {
  const unix = defineSqlMigration({
    id: "001_init",
    up: "create table t (id int);\ncreate index ti on t (id);\n",
  });
  const windows = defineSqlMigration({
    id: "001_init",
    up: "create table t (id int);  \r\ncreate index ti on t (id);\r\n",
  });

  // Same SQL with CRLF + trailing spaces hashes identically across platforms.
  assertEquals(
    calculateMigrationChecksum(unix),
    calculateMigrationChecksum(windows),
  );

  // Genuinely different SQL still produces a different checksum.
  const other = defineSqlMigration({
    id: "001_init",
    up: "create table other (id int);",
  });
  assertThrows(() =>
    assertMigrationChecksum(
      createAppliedMigration(unix),
      other,
    ), MigrationError);
});

Deno.test("@sisal/migrate - define validate sort and checksums", () => {
  const second = defineSqlMigration({
    id: "002_posts",
    up: "create table posts (id text)",
    down: "drop table posts",
  });
  const first = defineMigration({
    id: "001_users",
    up: (ctx) => ctx.driver.execute("select 1"),
    down: "select 1",
  });

  validateMigration(first);
  validateMigrations([second, first]);
  assertEquals(
    sortMigrations([second, first]).map((migration) => migration.id),
    [
      "001_users",
      "002_posts",
    ],
  );
  assertEquals(calculateMigrationChecksum(first).startsWith("migr_"), true);
  assertThrows(() => validateMigrations([first, first]), MigrationError);

  const applied = createAppliedMigration(first, {
    appliedAt: 0,
    executionMs: 5,
  });
  assertEquals(applied.appliedAt, "1970-01-01T00:00:00.000Z");
  assertMigrationChecksum(applied, first);
  assertThrows(
    () => assertMigrationChecksum({ ...applied, checksum: "bad" }, first),
    MigrationError,
  );
});

Deno.test("@sisal/migrate - plan helpers", () => {
  const first = defineSqlMigration({ id: "001", up: "up", down: "down" });
  const second = defineSqlMigration({ id: "002", up: "up", down: "down" });
  const applied = [createAppliedMigration(first)];
  const plan = createMigrationPlan([second, first], applied);

  assertEquals(plan.pending.map((item) => item.migration.id), ["002"]);
  assertEquals(plan.applied.map((item) => item.migration.id), ["001"]);
  assertEquals(plan.hasPending, true);
  assertEquals(
    getPendingMigrations([first, second], applied).map((item) => item.id),
    ["002"],
  );
  assertEquals(
    getAppliedMigrations([first, second], applied).map((item) => item.id),
    ["001"],
  );
  assertEquals(
    getRollbackMigrations([first, second], applied, 1).map((item) => item.id),
    ["001"],
  );
});

Deno.test("@sisal/migrate - schema migration plan accepts validated snapshots", () => {
  const from = {
    version: 2 as const,
    tables: [
      { name: "users", columns: [{ name: "id", type: { kind: "text" } }] },
    ],
  };
  const to = {
    version: 2 as const,
    tables: [
      { name: "posts", columns: [{ name: "id", type: { kind: "text" } }] },
      { name: "users", columns: [{ name: "id", type: { kind: "text" } }] },
    ],
  };
  const plan = defineSchemaMigrationPlan({ from, to });

  assertEquals(plan.from?.tables.map((table) => table.name), ["users"]);
  assertEquals(plan.to.tables.map((table) => table.name), ["posts", "users"]);

  assertThrows(() =>
    defineSchemaMigrationPlan({
      to: {
        version: 1 as 2,
        tables: [],
      },
    })
  );
});

Deno.test("@sisal/migrate - memory store and noop driver", async () => {
  const store = memoryMigrationStore({ cloneValues: true });
  const migration = createAppliedMigration(defineSqlMigration({
    id: "001",
    up: "up",
  }));

  await store.markApplied(migration);
  assertEquals((await store.listApplied()).length, 1);
  assertEquals((await store.getApplied("001"))?.id, "001");
  assertEquals(await store.acquireLock?.("lock"), true);
  assertEquals(await store.acquireLock?.("lock"), false);
  await store.releaseLock?.("lock");
  assertEquals(await store.unmarkApplied("001"), true);

  const driver = noopMigrationDriver();
  await driver.execute("select 1");
  assertEquals(await driver.transaction?.(() => Promise.resolve(1)), 1);
});

Deno.test("@sisal/migrate - transaction scope routes driver and store", async () => {
  const outerStore = recordingMigrationStore();
  const transactionStore = recordingMigrationStore();
  const outerSql: string[] = [];
  const transactionSql: string[] = [];
  const transactionDriver: MigrationDriver = {
    execute(sql: string): Promise<void> {
      transactionSql.push(sql);
      return Promise.resolve();
    },
  };
  const driver: MigrationDriver = {
    execute(sql: string): Promise<void> {
      outerSql.push(sql);
      return Promise.resolve();
    },
    transaction<T>(fn: (tx: MigrationTransaction) => Promise<T>): Promise<T> {
      return fn({
        driver: transactionDriver,
        store: transactionStore.store,
      });
    },
  };
  const migrator = createMigrator({
    migrations: [defineSqlMigration({ id: "001", up: "create table users" })],
    store: outerStore.store,
    driver,
  });

  const result = await migrator.up();

  assertEquals(result.executed.map((migration) => migration.id), ["001"]);
  assertEquals(outerSql, []);
  assertEquals(transactionSql, ["create table users"]);
  assertEquals(outerStore.marked.map((migration) => migration.id), []);
  assertEquals(transactionStore.marked.map((migration) => migration.id), [
    "001",
  ]);
});

Deno.test("@sisal/migrate - migrator plan up down dry-run and dirty checks", async () => {
  const first = defineSqlMigration({ id: "001", up: "up", down: "down" });
  const second = defineSqlMigration({ id: "002", up: "up", down: "down" });
  const store = memoryMigrationStore();
  const migrator = createMigrator({
    migrations: [second, first],
    store,
    driver: noopMigrationDriver(),
  });

  assertEquals((await migrator.plan()).pending.length, 2);
  assertEquals((await migrator.up({ dryRun: true })).skipped, ["001", "002"]);
  assertEquals((await store.listApplied()).length, 0);

  const up = await migrator.up({ steps: 2 });
  assertEquals(up.executed.map((migration) => migration.id), ["001", "002"]);
  assertEquals((await migrator.pending()).length, 0);

  const downDry = await migrator.down({ dryRun: true, steps: 1 });
  assertEquals(downDry.skipped, ["002"]);

  const down = await migrator.down({ steps: 1 });
  assertEquals(down.executed.map((migration) => migration.id), ["002"]);
  assertEquals((await migrator.applied()).map((migration) => migration.id), [
    "001",
  ]);

  const dirty = createMigrator({
    migrations: [
      defineSqlMigration({ id: "001", up: "changed", down: "down" }),
    ],
    store,
    driver: noopMigrationDriver(),
  });
  await assertRejects(() => dirty.up(), MigrationError);
  await dirty.up({ allowDirty: true });
});

Deno.test("@sisal/migrate - noop migrator", async () => {
  const migrator = noopMigrator();
  assertEquals((await migrator.plan()).items, []);
  assertEquals((await migrator.up()).executed, []);
  assertEquals((await migrator.down()).executed, []);
  assertEquals(await migrator.pending(), []);
  assertEquals(await migrator.applied(), []);
});

Deno.test("@sisal/migrate - planSchemaChanges classifies additive and destructive changes", () => {
  const from = snapshot([
    {
      name: "users",
      columns: [
        { name: "id", type: { kind: "uuid" } },
        { name: "email", type: { kind: "text" } },
      ],
    },
    { name: "legacy", columns: [{ name: "id", type: { kind: "uuid" } }] },
  ]);
  const to = snapshot([
    {
      name: "users",
      columns: [
        { name: "id", type: { kind: "uuid" } },
        { name: "email", type: { kind: "varchar", length: 320 } },
        { name: "name", type: { kind: "text" } },
      ],
    },
    { name: "posts", columns: [{ name: "id", type: { kind: "uuid" } }] },
  ]);

  const plan = planSchemaChanges({ from, to });
  const kinds = plan.changes.map((change) => `${change.kind}:${change.table}`);

  assertEquals(plan.isEmpty, false);
  assertEquals(kinds.includes("create_table:posts"), true);
  assertEquals(kinds.includes("add_column:users"), true);
  assertEquals(kinds.includes("alter_column:users"), true);
  assertEquals(kinds.includes("drop_table:legacy"), true);

  // alter/drop are destructive; create/add are not.
  assertEquals(
    plan.destructive.map((change) => change.kind).sort(),
    ["alter_column", "drop_table"],
  );
});

Deno.test("@sisal/migrate - planSchemaChanges with no prior snapshot creates every table", () => {
  const plan = planSchemaChanges({
    to: snapshot([{
      name: "t",
      columns: [{ name: "id", type: { kind: "uuid" } }],
    }]),
  });
  assertEquals(plan.changes.map((c) => c.kind), ["create_table"]);
  assertEquals(plan.destructive, []);

  // An identical from/to yields no changes.
  const same = snapshot([{
    name: "t",
    columns: [{ name: "id", type: { kind: "uuid" } }],
  }]);
  assertEquals(planSchemaChanges({ from: same, to: same }).isEmpty, true);
});

Deno.test("@sisal/migrate - migration filename and slug helpers", () => {
  assertEquals(
    formatMigrationFilename(2, "Create Users"),
    "0002_create_users.sql",
  );
  assertEquals(
    formatMigrationFilename(11, "add posts!!"),
    "0011_add_posts.sql",
  );
  assertEquals(formatMigrationFilename(1, ""), "0001.sql");
  assertEquals(formatMigrationFilename(3, "x", "json"), "0003_x.json");
  assertEquals(slugifyMigrationName("  Add  User__Email  "), "add_user_email");
});

Deno.test("@sisal/migrate - buildMigrationFile names and formats SQL", () => {
  const file = buildMigrationFile({
    sequence: 2,
    name: "Create Users",
    statements: ['CREATE TABLE "users" ()', "ALTER TABLE x ADD y;"],
    snapshot: snapshot([{
      name: "users",
      columns: [{ name: "id", type: { kind: "uuid" } }],
    }]),
  });

  assertEquals(file.id, "0002_create_users");
  assertEquals(file.sqlFileName, "0002_create_users.sql");
  assertEquals(file.snapshotFileName, "0002_create_users.snapshot.json");
  // Statements are terminated and separated by blank lines.
  assertEquals(file.sql, 'CREATE TABLE "users" ();\n\nALTER TABLE x ADD y;\n');
});

Deno.test("@sisal/migrate - writeMigrationFile + readMigrationsDir round-trip", async () => {
  const fs = fakeFs();
  const snap = snapshot([
    { name: "users", columns: [{ name: "id", type: { kind: "uuid" } }] },
  ]);

  const first = buildMigrationFile({
    sequence: 1,
    name: "initial",
    statements: ['CREATE TABLE "users" ()'],
    snapshot: snap,
  });
  await writeMigrationFile(fs, "migrations", first);

  const discovered = await readMigrationsDir(fs, "migrations");
  assertEquals(discovered.map((m) => m.id), ["0001_initial"]);
  assertEquals(discovered[0].sequence, 1);
  assertEquals(discovered[0].sql.includes('CREATE TABLE "users"'), true);
  assertEquals(discovered[0].snapshot?.tables[0].name, "users");

  assertEquals(parseMigrationSequence("0007_add_posts"), 7);
  assertEquals(nextMigrationSequence(discovered), 2);
});

Deno.test("@sisal/migrate - defineConfig validates and normalizes", () => {
  const config = defineConfig({
    dir: " ./migrations ",
    dialect: "postgres",
    databaseAuthToken: "secret",
    snapshot: snapshot([
      { name: "b", columns: [{ name: "id", type: { kind: "uuid" } }] },
      { name: "a", columns: [{ name: "id", type: { kind: "uuid" } }] },
    ]),
  });
  assertEquals(config.dir, "./migrations");
  assertEquals(config.databaseAuthToken, "secret");
  // Snapshot is normalized (tables sorted).
  assertEquals(config.snapshot?.tables.map((t) => t.name), ["a", "b"]);

  assertThrows(() => defineConfig({ dir: "  " }), MigrationError);
});

Deno.test("@sisal/migrate - checkDrift reports schema changes and pending", () => {
  const v1 = snapshot([
    { name: "users", columns: [{ name: "id", type: { kind: "uuid" } }] },
  ]);
  const v2 = snapshot([
    {
      name: "users",
      columns: [
        { name: "id", type: { kind: "uuid" } },
        { name: "email", type: { kind: "text" } },
      ],
    },
  ]);

  // Clean: current matches latest, nothing pending.
  assertEquals(
    checkDrift({ currentSnapshot: v1, latestSnapshot: v1 }).clean,
    true,
  );

  // Schema changed since the last captured snapshot.
  const drifted = checkDrift({ currentSnapshot: v2, latestSnapshot: v1 });
  assertEquals(drifted.clean, false);
  assertEquals(drifted.findings.map((f) => f.kind), ["schema_changed"]);

  // No migration captured yet at all.
  assertEquals(
    checkDrift({ currentSnapshot: v1 }).findings[0].kind,
    "schema_changed",
  );

  // Pending migrations + missing snapshot files.
  const report = checkDrift({
    currentSnapshot: v1,
    latestSnapshot: v1,
    pending: ["0002_x"],
    migrationsMissingSnapshot: ["0001_init"],
  });
  assertEquals(report.findings.map((f) => f.kind), [
    "pending_migrations",
    "missing_snapshot",
  ]);
});

Deno.test("@sisal/migrate - checkDrift detects a changed schema-object body", () => {
  // A stored function/trigger body lives in the snapshot's schemaObjects, so
  // changing it (same name, new `up`) drifts from the captured snapshot — item
  // 7's "drift accounts for changed function/trigger bodies".
  const withFn = (up: string): SisalSchemaSnapshot => ({
    version: 2,
    tables: [{ name: "t", columns: [{ name: "id", type: { kind: "uuid" } }] }],
    schemaObjects: [{
      name: "touch",
      kind: "function",
      dialect: "postgres",
      up,
    }],
  });
  const v1 = withFn("CREATE OR REPLACE FUNCTION touch() ... v1");
  const v2 = withFn("CREATE OR REPLACE FUNCTION touch() ... v2");

  assertEquals(
    checkDrift({ currentSnapshot: v1, latestSnapshot: v1 }).clean,
    true,
  );
  const drifted = checkDrift({ currentSnapshot: v2, latestSnapshot: v1 });
  assertEquals(drifted.clean, false);
  assertEquals(drifted.findings.map((f) => f.kind), ["schema_changed"]);
});
