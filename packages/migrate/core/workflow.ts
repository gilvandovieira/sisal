/**
 * SQL-first migration workflow: an injectable filesystem, generated-migration
 * file writing/reading, config, and drift checking.
 *
 * The filesystem is an injected interface, so the writer/reader are
 * unit-testable with an in-memory fake; the default Deno-backed implementation
 * needs `--allow-read`/`--allow-write`. The config, drift, and file-name logic
 * are pure.
 */

import {
  deserializeSchemaSnapshot,
  equalSchemaSnapshots,
  normalizeSchemaSnapshot,
  serializeSchemaSnapshot,
  type SisalDialectName,
  type SisalSchemaSnapshot,
} from "@sisal/orm";
import { formatMigrationFilename, MigrationError } from "./mod.ts";

/** Minimal filesystem surface used by the migration workflow. */
export interface MigrationFileSystem {
  /** Lists file names directly under a directory; `[]` when it does not exist. */
  readDir(path: string): Promise<readonly string[]>;
  /** Reads a UTF-8 file, returning `undefined` when it does not exist. */
  readFile(path: string): Promise<string | undefined>;
  writeFile(path: string, content: string): Promise<void>;
  /** Creates a directory recursively; a no-op when it already exists. */
  mkdir(path: string): Promise<void>;
}

/** A generated migration ready to be written to disk. */
export interface GeneratedMigrationFile {
  readonly id: string;
  readonly sqlFileName: string;
  readonly snapshotFileName: string;
  readonly sql: string;
  readonly snapshot: SisalSchemaSnapshot;
}

/** A migration discovered on disk by {@link readMigrationsDir}. */
export interface DiscoveredMigration {
  readonly id: string;
  readonly sequence: number;
  readonly fileName: string;
  readonly sql: string;
  /** The captured snapshot, when a matching `.snapshot.json` exists. */
  readonly snapshot?: SisalSchemaSnapshot;
}

const SNAPSHOT_SUFFIX = ".snapshot.json";

/** Builds the filenames and contents for a generated migration (pure). */
export function buildMigrationFile(options: {
  readonly sequence: number;
  readonly name: string;
  readonly statements: readonly string[];
  readonly snapshot: SisalSchemaSnapshot;
}): GeneratedMigrationFile {
  const sqlFileName = formatMigrationFilename(options.sequence, options.name);
  const id = sqlFileName.replace(/\.sql$/, "");
  const sql = options.statements.map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map((statement) => statement.endsWith(";") ? statement : `${statement};`)
    .join("\n\n");

  return {
    id,
    sqlFileName,
    snapshotFileName: `${id}${SNAPSHOT_SUFFIX}`,
    sql: `${sql}\n`,
    snapshot: normalizeSchemaSnapshot(options.snapshot),
  };
}

/** Writes a generated migration's `.sql` and `.snapshot.json` files. */
export async function writeMigrationFile(
  fs: MigrationFileSystem,
  dir: string,
  file: GeneratedMigrationFile,
): Promise<void> {
  await fs.mkdir(dir);
  await fs.writeFile(joinPath(dir, file.sqlFileName), file.sql);
  await fs.writeFile(
    joinPath(dir, file.snapshotFileName),
    `${serializeSchemaSnapshot(file.snapshot)}\n`,
  );
}

/** Reads and orders the `.sql` migrations in a directory (with their snapshots). */
export async function readMigrationsDir(
  fs: MigrationFileSystem,
  dir: string,
): Promise<DiscoveredMigration[]> {
  const names = [...await fs.readDir(dir)];
  const migrations: DiscoveredMigration[] = [];

  for (const name of names) {
    if (!name.endsWith(".sql")) {
      continue;
    }

    const sql = await fs.readFile(joinPath(dir, name));
    if (sql === undefined) {
      continue;
    }

    const id = name.replace(/\.sql$/, "");
    const snapshotText = await fs.readFile(
      joinPath(dir, `${id}${SNAPSHOT_SUFFIX}`),
    );

    migrations.push({
      id,
      sequence: parseMigrationSequence(id),
      fileName: name,
      sql,
      ...(snapshotText === undefined
        ? {}
        : { snapshot: deserializeSchemaSnapshot(snapshotText) }),
    });
  }

  return migrations.sort((a, b) =>
    a.sequence - b.sequence || a.id.localeCompare(b.id)
  );
}

/** Extracts the leading numeric sequence from a migration id (`0002_x` → `2`). */
export function parseMigrationSequence(id: string): number {
  const match = /^(\d+)/.exec(id);
  return match === null ? 0 : Number(match[1]);
}

/** Returns the next sequence number after the highest discovered migration. */
export function nextMigrationSequence(
  migrations: readonly DiscoveredMigration[],
): number {
  return migrations.reduce(
    (max, migration) => Math.max(max, migration.sequence),
    0,
  ) + 1;
}

/** Validated migration configuration (`sisal.migrate.ts`). */
export interface MigrateConfig {
  readonly dir: string;
  readonly dialect?: SisalDialectName;
  /** Prebuilt snapshot from the app (via `@sisal/orm`); omit for SQL-first. */
  readonly snapshot?: SisalSchemaSnapshot;
  readonly databaseUrl?: string;
  readonly historyTable?: string;
}

/** Validates and normalizes a migration config (pure). */
export function defineConfig(config: MigrateConfig): MigrateConfig {
  if (typeof config.dir !== "string" || config.dir.trim().length === 0) {
    throw new MigrationError("Migration config requires a non-empty dir", {
      code: "MIGRATION_INVALID",
      details: { field: "dir" },
    });
  }

  return Object.freeze({
    dir: config.dir.trim(),
    ...(config.dialect === undefined ? {} : { dialect: config.dialect }),
    ...(config.snapshot === undefined
      ? {}
      : { snapshot: normalizeSchemaSnapshot(config.snapshot) }),
    ...(config.databaseUrl === undefined
      ? {}
      : { databaseUrl: config.databaseUrl }),
    ...(config.historyTable === undefined
      ? {}
      : { historyTable: config.historyTable }),
  });
}

/** Drift categories reported by {@link checkDrift}. */
export type DriftKind =
  | "schema_changed"
  | "pending_migrations"
  | "missing_snapshot";

/** A single drift finding from {@link checkDrift}. */
export interface DriftFinding {
  readonly kind: DriftKind;
  readonly message: string;
}

/** Result of a drift check. */
export interface DriftReport {
  readonly clean: boolean;
  readonly findings: readonly DriftFinding[];
}

/** Inputs to {@link checkDrift}. */
export interface DriftCheckInput {
  /** The app's current schema snapshot (built via `@sisal/orm`). */
  readonly currentSnapshot?: SisalSchemaSnapshot;
  /** The snapshot captured by the newest generated migration, if any. */
  readonly latestSnapshot?: SisalSchemaSnapshot;
  /** Ids of migrations that exist but have not been applied. */
  readonly pending?: readonly string[];
  /** Migrations whose `.sql` file has no matching `.snapshot.json`. */
  readonly migrationsMissingSnapshot?: readonly string[];
}

/**
 * Decides whether migration state is consistent (pure). Reports when the live
 * schema has drifted from the newest captured snapshot (a migration needs to be
 * generated), when migrations are pending, and when a `.sql` file lacks its
 * `.snapshot.json`.
 */
export function checkDrift(input: DriftCheckInput): DriftReport {
  const findings: DriftFinding[] = [];

  if (input.currentSnapshot !== undefined) {
    const drifted = input.latestSnapshot === undefined ||
      !equalSchemaSnapshots(input.currentSnapshot, input.latestSnapshot);
    if (drifted) {
      findings.push({
        kind: "schema_changed",
        message:
          "Schema has changed since the last migration; generate a migration.",
      });
    }
  }

  if ((input.pending ?? []).length > 0) {
    findings.push({
      kind: "pending_migrations",
      message: `${input.pending?.length} migration(s) are pending.`,
    });
  }

  for (const id of input.migrationsMissingSnapshot ?? []) {
    findings.push({
      kind: "missing_snapshot",
      message: `Migration ${id} has no matching snapshot file.`,
    });
  }

  return { clean: findings.length === 0, findings };
}

/** Default {@link MigrationFileSystem} backed by Deno file APIs. */
export function denoMigrationFileSystem(): MigrationFileSystem {
  const deno = (globalThis as { readonly Deno?: DenoFsApi }).Deno;
  if (deno === undefined) {
    throw new MigrationError("Deno file APIs are not available", {
      code: "MIGRATION_UNKNOWN_ERROR",
    });
  }

  return {
    async readDir(path: string): Promise<readonly string[]> {
      const names: string[] = [];
      try {
        for await (const entry of deno.readDir(path)) {
          if (entry.isFile) {
            names.push(entry.name);
          }
        }
      } catch (cause) {
        if (cause instanceof deno.errors.NotFound) {
          return [];
        }
        throw cause;
      }
      return names;
    },

    async readFile(path: string): Promise<string | undefined> {
      try {
        return await deno.readTextFile(path);
      } catch (cause) {
        if (cause instanceof deno.errors.NotFound) {
          return undefined;
        }
        throw cause;
      }
    },

    writeFile(path: string, content: string): Promise<void> {
      return deno.writeTextFile(path, content);
    },

    async mkdir(path: string): Promise<void> {
      await deno.mkdir(path, { recursive: true });
    },
  };
}

interface DenoFsApi {
  readDir(path: string): AsyncIterable<{ name: string; isFile: boolean }>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options: { recursive: boolean }): Promise<void>;
  readonly errors: { readonly NotFound: new (...args: never[]) => Error };
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}
