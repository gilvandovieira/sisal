/**
 * CLI/process-boundary and migration workflow benchmark scenario.
 *
 * @module
 */

import type { SisalSchemaSnapshot } from "@sisal/orm";
import { generateSqliteUpStatements } from "@sisal/sqlite/ddl";
import {
  buildMigrationFile,
  checkDrift,
  createMigrator,
  defineSqlMigration,
  memoryMigrationStore,
  type MigrationFileSystem,
  type MigrationResult,
  nextMigrationSequence,
  noopMigrationDriver,
  readMigrationsDir,
  type SqlMigration,
  writeMigrationFile,
} from "@sisal/migrate";
import type { BenchmarkScenario } from "../harness.ts";

const GROUP = "cli + migrations";
const MIGRATION_COUNT = 24;
const WORKSPACE_ROOT = new URL("../../", import.meta.url);

const snapshotV1: SisalSchemaSnapshot = {
  version: 1,
  dialect: "sqlite",
  tables: [
    {
      name: "users",
      columns: [
        { name: "id", type: { kind: "uuid" }, nullable: false },
        { name: "email", type: { kind: "text" }, nullable: false },
      ],
      primaryKey: { columns: ["id"] },
      uniqueConstraints: [{ columns: ["email"] }],
    },
  ],
};

const snapshotV2: SisalSchemaSnapshot = {
  version: 1,
  dialect: "sqlite",
  tables: [
    {
      name: "users",
      columns: [
        { name: "id", type: { kind: "uuid" }, nullable: false },
        { name: "email", type: { kind: "text" }, nullable: false },
        { name: "display_name", type: { kind: "text" } },
      ],
      primaryKey: { columns: ["id"] },
      uniqueConstraints: [{ columns: ["email"] }],
    },
    {
      name: "posts",
      columns: [
        { name: "id", type: { kind: "uuid" }, nullable: false },
        { name: "author_id", type: { kind: "uuid" }, nullable: false },
        { name: "title", type: { kind: "text" }, nullable: false },
        {
          name: "published",
          type: { kind: "boolean" },
          default: { kind: "literal", value: false },
        },
      ],
      primaryKey: { columns: ["id"] },
      foreignKeys: [
        {
          columns: ["author_id"],
          references: { table: "users", columns: ["id"] },
        },
      ],
    },
  ],
};

const migrations = Array.from(
  { length: MIGRATION_COUNT },
  (_, index): SqlMigration => {
    const sequence = String(index + 1).padStart(4, "0");

    return defineSqlMigration({
      id: `${sequence}_change_${index + 1}`,
      up: `select ${index + 1};`,
      down: `select ${index};`,
    });
  },
);

export const migrateCliScenarios: readonly BenchmarkScenario[] = [
  {
    group: GROUP,
    name: "migration workflow files + drift",
    baseline: true,
    async fn() {
      await runMigrationWorkflowScenario();
    },
  },
  {
    group: GROUP,
    name: `core migrator up/down ${MIGRATION_COUNT} sql migrations`,
    async fn() {
      await runCoreMigratorScenario();
    },
  },
  {
    group: GROUP,
    name: "deno cli eval migration smoke",
    n: 5,
    warmup: 1,
    permissions: { run: ["deno"] },
    async fn() {
      await runCliMigrationBoundaryScenario();
    },
  },
];

async function runMigrationWorkflowScenario(): Promise<void> {
  const fs = memoryMigrationFileSystem();
  const initial = buildMigrationFile({
    sequence: 1,
    name: "initial",
    statements: generateSqliteUpStatements(snapshotV1).statements,
    snapshot: snapshotV1,
  });

  await writeMigrationFile(fs, "migrations", initial);

  const discovered = await readMigrationsDir(fs, "migrations");
  const update = buildMigrationFile({
    sequence: nextMigrationSequence(discovered),
    name: "add posts",
    statements: generateSqliteUpStatements(snapshotV2, snapshotV1).statements,
    snapshot: snapshotV2,
  });

  await writeMigrationFile(fs, "migrations", update);

  const written = await readMigrationsDir(fs, "migrations");
  const latestSnapshot = written.at(-1)?.snapshot;
  const report = checkDrift({
    currentSnapshot: snapshotV2,
    latestSnapshot,
    pending: [],
    migrationsMissingSnapshot: written
      .filter((migration) => migration.snapshot === undefined)
      .map((migration) => migration.id),
  });

  if (!report.clean) {
    throw new Error("Expected migration workflow scenario to be drift-free.");
  }
}

async function runCoreMigratorScenario(): Promise<MigrationResult> {
  const migrator = createMigrator({
    migrations: [...migrations],
    store: memoryMigrationStore(),
    driver: noopMigrationDriver(),
  });

  await migrator.plan();
  await migrator.up();
  return await migrator.down({ steps: Math.floor(MIGRATION_COUNT / 2) });
}

async function runCliMigrationBoundaryScenario(): Promise<void> {
  const command = new Deno.Command("deno", {
    args: ["eval", CLI_MIGRATION_SMOKE_SCRIPT],
    cwd: WORKSPACE_ROOT,
    clearEnv: true,
    stdout: "null",
    stderr: "piped",
  });
  const output = await command.output();

  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr).trim();
    throw new Error(
      `CLI migration smoke failed with status ${output.code}: ${stderr}`,
    );
  }
}

function memoryMigrationFileSystem(): MigrationFileSystem {
  const files = new Map<string, string>();

  return {
    readDir(path: string): Promise<readonly string[]> {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const names = new Set<string>();

      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) {
          continue;
        }

        const name = key.slice(prefix.length);
        if (!name.includes("/")) {
          names.add(name);
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

const CLI_MIGRATION_SMOKE_SCRIPT = `
import {
  buildMigrationFile,
  checkDrift,
  createMigrator,
  defineSqlMigration,
  memoryMigrationStore,
  noopMigrationDriver,
  readMigrationsDir,
  writeMigrationFile,
} from "@sisal/migrate";

const snapshot = {
  version: 1,
  dialect: "sqlite",
  tables: [{
    name: "users",
    columns: [
      { name: "id", type: { kind: "uuid" }, nullable: false },
      { name: "email", type: { kind: "text" }, nullable: false },
    ],
    primaryKey: { columns: ["id"] },
  }],
};
const files = new Map();
const fs = {
  readDir(path) {
    const prefix = path.endsWith("/") ? path : path + "/";
    return Promise.resolve([...files.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .filter((name) => !name.includes("/")));
  },
  readFile(path) {
    return Promise.resolve(files.get(path));
  },
  writeFile(path, content) {
    files.set(path, content);
    return Promise.resolve();
  },
  mkdir() {
    return Promise.resolve();
  },
};
const file = buildMigrationFile({
  sequence: 1,
  name: "initial",
  statements: ['CREATE TABLE "users" ("id" TEXT NOT NULL, "email" TEXT NOT NULL);'],
  snapshot,
});

await writeMigrationFile(fs, "migrations", file);
const discovered = await readMigrationsDir(fs, "migrations");
const migrations = discovered.map((migration) => defineSqlMigration({
  id: migration.id,
  up: migration.sql,
  down: 'DROP TABLE "users";',
}));
const migrator = createMigrator({
  migrations,
  store: memoryMigrationStore(),
  driver: noopMigrationDriver(),
});

await migrator.up();
const report = checkDrift({
  currentSnapshot: snapshot,
  latestSnapshot: discovered.at(-1)?.snapshot,
  pending: (await migrator.pending()).map((migration) => migration.id),
});

if (!report.clean) {
  throw new Error(JSON.stringify(report.findings));
}
`;
