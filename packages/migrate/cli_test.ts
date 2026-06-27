import { assertEquals, assertStringIncludes } from "@std/assert";
import type { SisalSchemaSnapshot } from "@sisal/orm";
import {
  buildMigrationFile,
  createAppliedMigration,
  createMigrationPlan,
  type MigrateConfig,
  type MigrationFileSystem,
  readMigrationsDir,
  writeMigrationFile,
} from "./mod.ts";
import {
  runSisalCli,
  type SisalCliAdapter,
  type SisalCliMigrator,
} from "./cli.ts";

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
        if (!key.startsWith(prefix)) {
          continue;
        }

        const rest = key.slice(prefix.length);
        if (!rest.includes("/")) {
          names.add(rest);
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

const snapshotV1: SisalSchemaSnapshot = {
  version: 1,
  dialect: "sqlite",
  tables: [
    {
      name: "users",
      columns: [
        { name: "id", type: { kind: "uuid" }, nullable: false },
      ],
      primaryKey: { columns: ["id"] },
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
      ],
      primaryKey: { columns: ["id"] },
    },
  ],
};

Deno.test("sisal cli - generate writes SQL and snapshot files", async () => {
  const fs = fakeFs();
  const output: string[] = [];
  let fromSnapshot: SisalSchemaSnapshot | undefined;
  const adapter: SisalCliAdapter = {
    generateUpStatements(_to, from) {
      fromSnapshot = from;
      return {
        statements: ['CREATE TABLE "users" ("id" TEXT NOT NULL);'],
        destructive: [],
      };
    },
  };
  const config: MigrateConfig = {
    dir: "migrations",
    dialect: "sqlite",
    snapshot: snapshotV1,
  };

  const code = await runSisalCli(["generate", "initial"], {
    config,
    fs,
    adapters: { sqlite: adapter },
    stdout: (line) => output.push(line),
  });
  const discovered = await readMigrationsDir(fs, "migrations");

  assertEquals(code, 0);
  assertEquals(fromSnapshot, undefined);
  assertEquals(discovered.map((migration) => migration.id), ["0001_initial"]);
  assertEquals(discovered[0].snapshot?.tables[0].name, "users");
  assertStringIncludes(output.join("\n"), "0001_initial.sql");
});

Deno.test("sisal cli - drift is clean after generated snapshot matches config", async () => {
  const fs = fakeFs();
  const output: string[] = [];
  const adapter: SisalCliAdapter = {
    generateUpStatements() {
      return {
        statements: ['CREATE TABLE "users" ("id" TEXT NOT NULL);'],
        destructive: [],
      };
    },
  };
  const config: MigrateConfig = {
    dir: "migrations",
    dialect: "sqlite",
    snapshot: snapshotV1,
  };

  await runSisalCli(["generate", "initial"], {
    config,
    fs,
    adapters: { sqlite: adapter },
    stdout() {},
  });
  const code = await runSisalCli(["drift"], {
    config,
    fs,
    adapters: { sqlite: adapter },
    stdout: (line) => output.push(line),
  });

  assertEquals(code, 0);
  assertEquals(output, ["Drift clean."]);
});

Deno.test("sisal cli - allow-empty writes a readable noop migration", async () => {
  const fs = fakeFs();
  const adapter: SisalCliAdapter = {
    generateUpStatements() {
      return { statements: [], destructive: [] };
    },
  };

  const code = await runSisalCli(["generate", "marker", "--allow-empty"], {
    config: { dir: "migrations", dialect: "sqlite", snapshot: snapshotV1 },
    fs,
    adapters: { sqlite: adapter },
    stdout() {},
  });
  const discovered = await readMigrationsDir(fs, "migrations");

  assertEquals(code, 0);
  assertEquals(discovered[0].sql, "select 1;\n");
});

Deno.test("sisal cli - status and dry-run migrate use adapter plan", async () => {
  const fs = fakeFs();
  const statusOutput: string[] = [];
  const migrateOutput: string[] = [];
  let migrateSteps: number | undefined;
  const first = buildMigrationFile({
    sequence: 1,
    name: "initial",
    statements: ['CREATE TABLE "users" ("id" TEXT NOT NULL);'],
    snapshot: snapshotV1,
  });
  const second = buildMigrationFile({
    sequence: 2,
    name: "add email",
    statements: ['ALTER TABLE "users" ADD COLUMN "email" TEXT NOT NULL;'],
    snapshot: snapshotV2,
  });
  await writeMigrationFile(fs, "migrations", first);
  await writeMigrationFile(fs, "migrations", second);

  const migrator: SisalCliMigrator = {
    migrate(options) {
      migrateSteps = options.steps;
      return Promise.resolve({
        direction: "up",
        dryRun: options.dryRun ?? false,
        executed: [],
        skipped: options.migrations.slice(0, options.steps).map((m) => m.id),
        executionMs: 0,
      });
    },
    plan(options) {
      const [applied] = options.migrations;
      return Promise.resolve(createMigrationPlan([...options.migrations], [
        createAppliedMigration(applied),
      ]));
    },
  };
  const adapter: SisalCliAdapter = {
    generateUpStatements() {
      return { statements: [], destructive: [] };
    },
    createMigrator() {
      return Promise.resolve(migrator);
    },
  };
  const config: MigrateConfig = {
    dir: "migrations",
    dialect: "sqlite",
    snapshot: snapshotV2,
  };

  assertEquals(
    await runSisalCli(["status"], {
      config,
      fs,
      adapters: { sqlite: adapter },
      stdout: (line) => statusOutput.push(line),
    }),
    0,
  );
  assertEquals(
    await runSisalCli(["migrate", "--dry-run", "--steps", "1"], {
      config,
      fs,
      adapters: { sqlite: adapter },
      stdout: (line) => migrateOutput.push(line),
    }),
    0,
  );

  assertStringIncludes(statusOutput.join("\n"), "1 applied migration(s).");
  assertStringIncludes(statusOutput.join("\n"), "1 pending migration(s).");
  assertStringIncludes(statusOutput.join("\n"), "pending_migrations");
  assertEquals(migrateSteps, 1);
  assertEquals(migrateOutput, [
    "Would apply 1 migration(s): 0001_initial",
  ]);
});

Deno.test("sisal cli - migrate splits multi-statement SQL files", async () => {
  const fs = fakeFs();
  let upStep: unknown;
  const file = buildMigrationFile({
    sequence: 1,
    name: "initial",
    statements: [
      'CREATE TABLE "users" ("id" TEXT NOT NULL);',
      'CREATE INDEX users_id_idx ON "users" ("id");',
    ],
    snapshot: snapshotV1,
  });
  await writeMigrationFile(fs, "migrations", file);

  const adapter: SisalCliAdapter = {
    generateUpStatements() {
      return { statements: [], destructive: [] };
    },
    createMigrator() {
      return Promise.resolve({
        migrate(options) {
          upStep = options.migrations[0].up;
          return Promise.resolve({
            direction: "up",
            dryRun: options.dryRun ?? false,
            executed: [],
            skipped: [],
            executionMs: 0,
          });
        },
        plan() {
          return Promise.resolve(createMigrationPlan([], []));
        },
      });
    },
  };

  const code = await runSisalCli(["migrate", "--dry-run"], {
    config: { dir: "migrations", dialect: "sqlite", snapshot: snapshotV1 },
    fs,
    adapters: { sqlite: adapter },
    stdout() {},
  });

  assertEquals(code, 0);
  assertEquals(Array.isArray(upStep), true);
  assertEquals((upStep as readonly string[]).length, 2);
});

Deno.test("sisal cli - passes database auth token to adapters", async () => {
  const fs = fakeFs();
  let seenToken: string | undefined;
  const adapter: SisalCliAdapter = {
    generateUpStatements() {
      return { statements: [], destructive: [] };
    },
    createMigrator(options) {
      seenToken = options.config.databaseAuthToken;
      return Promise.resolve({
        migrate(migrateOptions) {
          return Promise.resolve({
            direction: "up",
            dryRun: migrateOptions.dryRun ?? false,
            executed: [],
            skipped: [],
            executionMs: 0,
          });
        },
        plan() {
          return Promise.resolve(createMigrationPlan([], []));
        },
      });
    },
  };

  const code = await runSisalCli([
    "migrate",
    "--database-auth-token",
    "secret",
  ], {
    config: {
      dir: "migrations",
      dialect: "sqlite",
      snapshot: snapshotV1,
      databaseUrl: "libsql://example.turso.io",
    },
    fs,
    adapters: { sqlite: adapter },
    stdout() {},
  });

  assertEquals(code, 0);
  assertEquals(seenToken, "secret");
});

Deno.test("sisal cli - init scaffolds config and refuses overwrite", async () => {
  const fs = fakeFs();
  const out: string[] = [];
  const err: string[] = [];

  const first = await runSisalCli(["init", "--dialect", "sqlite"], {
    fs,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });
  assertEquals(first, 0);
  const config = fs.files.get("sisal.migrate.ts");
  assertStringIncludes(config ?? "", 'dir: "migrations"');
  assertStringIncludes(config ?? "", 'dialect: "sqlite"');
  assertStringIncludes(out.join("\n"), "Created sisal.migrate.ts");

  // Refuses to overwrite an existing config without --force.
  const second = await runSisalCli(["init"], {
    fs,
    stdout() {},
    stderr: (line) => err.push(line),
  });
  assertEquals(second, 1);
  assertStringIncludes(err.join("\n"), "already exists");

  // Overwrites with --force, honoring the chosen dialect.
  const third = await runSisalCli(
    ["init", "--force", "--dialect", "postgres"],
    {
      fs,
      stdout() {},
      stderr() {},
    },
  );
  assertEquals(third, 0);
  assertStringIncludes(
    fs.files.get("sisal.migrate.ts") ?? "",
    'dialect: "postgres"',
  );
});

Deno.test("sisal cli - init scaffolds libsql target as sqlite dialect", async () => {
  const fs = fakeFs();

  const code = await runSisalCli(["init", "--target", "turso"], {
    fs,
    stdout() {},
    stderr() {},
  });
  const config = fs.files.get("sisal.migrate.ts") ?? "";

  assertEquals(code, 0);
  assertStringIncludes(config, 'dialect: "sqlite"');
  assertStringIncludes(config, "TURSO_DATABASE_URL");
  assertStringIncludes(config, "TURSO_AUTH_TOKEN");
});

Deno.test("sisal cli - init rejects an unknown target and lists supported ones", async () => {
  const errs: string[] = [];
  const code = await runSisalCli(["init", "--target", "mongodb"], {
    fs: fakeFs(),
    stdout() {},
    stderr: (line) => errs.push(line),
  });
  assertEquals(code, 1);
  assertStringIncludes(errs.join("\n"), "Unknown target");
  assertStringIncludes(errs.join("\n"), "libsql");
});

Deno.test("sisal cli - generate refuses destructive changes", async () => {
  const fs = fakeFs();
  const errors: string[] = [];
  const adapter: SisalCliAdapter = {
    generateUpStatements() {
      return {
        statements: [],
        destructive: [{
          kind: "drop_table",
          table: "legacy",
          destructive: true,
        }],
      };
    },
  };

  const code = await runSisalCli(["generate", "drop legacy"], {
    config: { dir: "migrations", dialect: "sqlite", snapshot: snapshotV1 },
    fs,
    adapters: { sqlite: adapter },
    stderr: (line) => errors.push(line),
  });

  assertEquals(code, 1);
  assertEquals(await readMigrationsDir(fs, "migrations"), []);
  assertStringIncludes(errors.join("\n"), "Destructive schema changes");
});
