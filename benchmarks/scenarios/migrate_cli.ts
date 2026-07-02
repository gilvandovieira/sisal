/**
 * Migration workflow benchmark scenarios.
 *
 * These exercise Sisal's migration file/drift workflow and the core migrator's
 * apply/rollback path against in-memory stores and a noop driver — no database
 * and no subprocess, so the numbers stay focused on Sisal's own work.
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

const GROUP = "migrations";
const MIGRATION_COUNT = 24;

const snapshotV1: SisalSchemaSnapshot = {
  version: 2,
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
  version: 2,
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
