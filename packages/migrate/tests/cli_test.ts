import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { SisalSchemaSnapshot } from "@sisal/core";
import {
  buildMigrationFile,
  createAppliedMigration,
  createMigrationPlan,
  defineConfig,
  type MigrateConfig,
  type MigrationFileSystem,
  readMigrationsDir,
  writeMigrationFile,
} from "../mod.ts";
import {
  runSisalCli,
  type SisalCliAdapter,
  type SisalCliMigrator,
} from "../src/cli.ts";

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
  version: 2,
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
    },
  ],
};

const mysqlSnapshot: SisalSchemaSnapshot = {
  version: 2,
  dialect: "mysql",
  tables: [
    {
      name: "users",
      columns: [
        { name: "id", type: { kind: "serial" }, nullable: false },
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

Deno.test("sisal cli - log-level creates formatted runtime logger", async () => {
  const fs = fakeFs();
  const out: string[] = [];
  let seenLevel: string | undefined;
  const adapter: SisalCliAdapter = {
    generateUpStatements() {
      return { statements: [], destructive: [] };
    },
    createMigrator(options) {
      seenLevel = options.logging?.level;
      options.logging?.logger?.log({
        level: "debug",
        category: "migrate.plan",
        message: "migration plan completed",
        record: { pending: 1 },
      });
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

  const code = await runSisalCli(["migrate", "--log-level", "debug"], {
    config: { dir: "migrations", dialect: "sqlite", snapshot: snapshotV1 },
    fs,
    adapters: { sqlite: adapter },
    stdout: (line) => out.push(line),
  });

  assertEquals(code, 0);
  assertEquals(seenLevel, "debug");
  assertEquals(
    out[0],
    '[debug] migrate.plan: migration plan completed {"pending":1}',
  );
});

Deno.test("sisal cli - verbose flags map to debug and trace levels", async () => {
  const levels: Array<string | undefined> = [];
  const adapter: SisalCliAdapter = {
    generateUpStatements() {
      return { statements: [], destructive: [] };
    },
    createMigrator(options) {
      levels.push(options.logging?.level);
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
  const config: MigrateConfig = {
    dir: "migrations",
    dialect: "sqlite",
    snapshot: snapshotV1,
  };

  await runSisalCli(["migrate", "-v"], {
    config,
    fs: fakeFs(),
    adapters: { sqlite: adapter },
    stdout() {},
  });
  await runSisalCli(["migrate", "-vv"], {
    config,
    fs: fakeFs(),
    adapters: { sqlite: adapter },
    stdout() {},
  });
  await runSisalCli(["migrate", "--verbose", "--verbose"], {
    config,
    fs: fakeFs(),
    adapters: { sqlite: adapter },
    stdout() {},
  });

  assertEquals(levels, ["debug", "trace", "trace"]);
});

Deno.test("sisal cli - quiet suppresses non-error output", async () => {
  const fs = fakeFs();
  const out: string[] = [];
  const err: string[] = [];

  const code = await runSisalCli(["init", "--quiet"], {
    fs,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });

  assertEquals(code, 0);
  assertEquals(out, []);
  assertEquals(err, []);
});

Deno.test("sisal cli - logging flags conflict clearly", async () => {
  const err: string[] = [];
  const code = await runSisalCli([
    "status",
    "--quiet",
    "--log-level",
    "debug",
  ], {
    stdout() {},
    stderr: (line) => err.push(line),
  });

  assertEquals(code, 1);
  assertStringIncludes(err.join("\n"), "Use only one of");
});

Deno.test("sisal cli - config logging is accepted and flags override it", async () => {
  assertEquals(
    defineConfig({
      dir: "migrations",
      dialect: "sqlite",
      logging: { level: "error", categories: { "migrate.sql": true } },
    }).logging?.level,
    "error",
  );

  let seenLevel: string | undefined;
  const adapter: SisalCliAdapter = {
    generateUpStatements() {
      return { statements: [], destructive: [] };
    },
    createMigrator(options) {
      seenLevel = options.logging?.level;
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

  const code = await runSisalCli(["migrate", "--log-level", "debug"], {
    config: {
      dir: "migrations",
      dialect: "sqlite",
      snapshot: snapshotV1,
      logging: { level: "error" },
    },
    fs: fakeFs(),
    adapters: { sqlite: adapter },
    stdout() {},
  });

  assertEquals(code, 0);
  assertEquals(seenLevel, "debug");
});

Deno.test("sisal cli - secrets never appear in logged output", async () => {
  const out: string[] = [];
  const errs: string[] = [];
  const adapter: SisalCliAdapter = {
    generateUpStatements() {
      return { statements: [], destructive: [] };
    },
    createMigrator(options) {
      // Drive the CLI's log formatter with a normal event; nothing it prints
      // may carry the connection URL password or the auth token.
      options.logging?.logger?.log({
        level: "debug",
        category: "migrate.step",
        message: "migration completed",
        record: { id: "0001" },
      });
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
    "--log-level",
    "trace",
    "--database-auth-token",
    "tok-SECRET",
  ], {
    config: {
      dir: "migrations",
      dialect: "sqlite",
      snapshot: snapshotV1,
      databaseUrl: "libsql://user:pw-SECRET@example.turso.io",
    },
    fs: fakeFs(),
    adapters: { sqlite: adapter },
    stdout: (line) => out.push(line),
    stderr: (line) => errs.push(line),
  });

  assertEquals(code, 0);
  const combined = [...out, ...errs].join("\n");
  assert(
    !combined.includes("pw-SECRET"),
    "connection password must not be logged",
  );
  assert(!combined.includes("tok-SECRET"), "auth token must not be logged");
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

  // Scaffold targets the host runtime: npm scope + `process.env` on Node, JSR
  // scope + `Deno.env.get` on Deno. Assert internal consistency rather than
  // predicting the runtime — the dnt Node test shim makes `globalThis.Deno`
  // ambiguous, so this test can't reliably guess which the shipped code chose.
  const usesNpmScope = (config ?? "").includes(
    'from "@sisaljs/migrate/workflow"',
  );
  const usesJsrScope = (config ?? "").includes(
    'from "@sisal/migrate/workflow"',
  );
  assert(
    usesNpmScope !== usesJsrScope,
    "scaffold imports exactly one workflow scope",
  );

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
  const pgConfig = fs.files.get("sisal.migrate.ts") ?? "";
  assertStringIncludes(pgConfig, 'dialect: "postgres"');
  // The `DATABASE_URL` env hint matches the scope the scaffold chose.
  assertStringIncludes(
    pgConfig,
    pgConfig.includes('from "@sisaljs/migrate/workflow"')
      ? "process.env.DATABASE_URL"
      : 'Deno.env.get("DATABASE_URL")',
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

Deno.test("sisal cli - init scaffolds neon target (postgres dialect, neon provider)", async () => {
  const fs = fakeFs();

  const code = await runSisalCli(["init", "--target", "neon"], {
    fs,
    stdout() {},
    stderr() {},
  });
  const config = fs.files.get("sisal.migrate.ts") ?? "";

  assertEquals(code, 0);
  assertStringIncludes(config, 'dialect: "postgres"');
  assertStringIncludes(config, 'provider: "neon"');
  assertStringIncludes(config, "DATABASE_URL");
});

Deno.test("sisal cli - init scaffolds mysql target and mariadb alias", async () => {
  const fs = fakeFs();

  const first = await runSisalCli(["init", "--target", "mysql"], {
    fs,
    stdout() {},
    stderr() {},
  });
  const config = fs.files.get("sisal.migrate.ts") ?? "";

  assertEquals(first, 0);
  assertStringIncludes(config, 'dialect: "mysql"');
  assertStringIncludes(config, "MYSQL_URL");
  assertStringIncludes(config, "DATABASE_URL");

  const second = await runSisalCli(
    ["init", "--force", "--target", "mariadb"],
    {
      fs,
      stdout() {},
      stderr() {},
    },
  );
  assertEquals(second, 0);
  assertStringIncludes(
    fs.files.get("sisal.migrate.ts") ?? "",
    'dialect: "mysql"',
  );
});

Deno.test("sisal cli - migrate applies a neon-provider config (postgres dialect)", async () => {
  const fs = fakeFs();
  const file = buildMigrationFile({
    sequence: 1,
    name: "initial",
    statements: ['CREATE TABLE "users" ("id" TEXT NOT NULL);'],
    snapshot: snapshotV1,
  });
  await writeMigrationFile(fs, "migrations", file);

  const out: string[] = [];
  let createMigratorCalled = false;
  const adapter: SisalCliAdapter = {
    generateUpStatements() {
      return { statements: [], destructive: [] };
    },
    createMigrator() {
      createMigratorCalled = true;
      return Promise.resolve({
        migrate(options) {
          return Promise.resolve({
            direction: "up",
            dryRun: false,
            executed: options.migrations.map((m) => createAppliedMigration(m)),
            skipped: [],
            executionMs: 0,
          });
        },
        plan(options) {
          return Promise.resolve(
            createMigrationPlan([...options.migrations], []),
          );
        },
      });
    },
  };
  // Neon keeps the postgres dialect; the injected postgres adapter is used.
  const config: MigrateConfig = {
    dir: "migrations",
    dialect: "postgres",
    provider: "neon",
    databaseUrl: "postgres://example.neon.tech/db",
    snapshot: snapshotV1,
  };

  const code = await runSisalCli(["migrate"], {
    config,
    fs,
    adapters: { postgres: adapter },
    stdout: (line) => out.push(line),
  });

  assertEquals(code, 0);
  assertEquals(createMigratorCalled, true);
  assertStringIncludes(out.join("\n"), "Applied 1 migration(s): 0001_initial");
});

Deno.test("sisal cli - migrate applies a mysql config", async () => {
  const fs = fakeFs();
  let seenUrl: string | undefined;
  let seenDialect: string | undefined;
  const adapter: SisalCliAdapter = {
    generateUpStatements() {
      return { statements: [], destructive: [] };
    },
    createMigrator(options) {
      seenUrl = options.config.databaseUrl;
      seenDialect = options.dialect;
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

  const code = await runSisalCli(["migrate"], {
    config: {
      dir: "migrations",
      dialect: "mysql",
      databaseUrl: "mysql://root:root@localhost:3306/sisal",
      snapshot: mysqlSnapshot,
    },
    fs,
    adapters: { mysql: adapter },
    stdout() {},
  });

  assertEquals(code, 0);
  assertEquals(seenDialect, "mysql");
  assertEquals(seenUrl, "mysql://root:root@localhost:3306/sisal");
});

Deno.test("defineConfig accepts the neon provider and rejects unknown providers", () => {
  assertEquals(
    defineConfig({ dir: "migrations", dialect: "postgres", provider: "neon" })
      .provider,
    "neon",
  );
  let threw = false;
  try {
    // deno-lint-ignore no-explicit-any -- an unsupported provider value
    defineConfig({ dir: "migrations", provider: "mysql" as any });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
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
  assertStringIncludes(errs.join("\n"), "mysql");
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
