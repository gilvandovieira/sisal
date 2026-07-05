/**
 * SQL-first migration workflow: an injectable filesystem, generated-migration
 * file writing/reading, config, and drift checking.
 *
 * The filesystem is an injected interface, so the writer/reader are
 * unit-testable with an in-memory fake; the default Deno-backed implementation
 * needs `--allow-read`/`--allow-write`. The config, drift, and file-name logic
 * are pure.
 *
 * @module
 */

import {
  deserializeSchemaSnapshot,
  equalSchemaSnapshots,
  isSisalLogCategory,
  isSisalLogLevel,
  normalizeSchemaSnapshot,
  serializeSchemaSnapshot,
  type SisalDialectName,
  type SisalLogSettings,
  type SisalSchemaSnapshot,
} from "@sisal/core";
import { formatMigrationFilename, MigrationError } from "./mod.ts";

/** Minimal filesystem surface used by the migration workflow. */
export interface MigrationFileSystem {
  /** Lists file names directly under a directory; `[]` when it does not exist. */
  readDir(path: string): Promise<readonly string[]>;
  /** Reads a UTF-8 file, returning `undefined` when it does not exist. */
  readFile(path: string): Promise<string | undefined>;
  /** write file for this migration file system. */
  writeFile(path: string, content: string): Promise<void>;
  /** Creates a directory recursively; a no-op when it already exists. */
  mkdir(path: string): Promise<void>;
}

/** A generated migration ready to be written to disk. */
export interface GeneratedMigrationFile {
  /** sql file name for this generated migration file. */
  readonly id: string;
  /** snapshot file name for this generated migration file. */
  readonly sqlFileName: string;
  /** SQL text used by this generated migration file. */
  readonly snapshotFileName: string;
  /** snapshot for this generated migration file. */
  readonly sql: string;
  /** snapshot for this generated migration file. */
  readonly snapshot: SisalSchemaSnapshot;
}

/** A migration discovered on disk by {@link readMigrationsDir}. */
export interface DiscoveredMigration {
  /** sequence for this discovered migration. */
  readonly id: string;
  /** file name for this discovered migration. */
  readonly sequence: number;
  /** SQL text used by this discovered migration. */
  readonly fileName: string;
  /** SQL text used by this discovered migration. */
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

/** A migration runtime provider that refines a dialect's default adapter. */
export type MigrateProvider = "neon";

/** Validated migration configuration (`sisal.migrate.ts`). */
export interface MigrateConfig {
  /** dialect for this migrate config. */
  readonly dir: string;
  /** dialect for this migrate config. */
  readonly dialect?: SisalDialectName;
  /**
   * Runtime adapter override for a dialect. `"neon"` keeps the `postgres`
   * dialect (PostgreSQL DDL) but applies migrations through `@sisal/neon`'s
   * serverless/HTTP transport, statement-by-statement.
   */
  readonly provider?: MigrateProvider;
  /** Prebuilt snapshot from the app (via `@sisal/orm`); omit for SQL-first. */
  readonly snapshot?: SisalSchemaSnapshot;
  /** PostgreSQL connection URL. Also accepted as a SQLite path fallback. */
  readonly databaseUrl?: string;
  /** Authentication token for URL-based database transports such as Turso. */
  readonly databaseAuthToken?: string;
  /** SQLite database file path (`:memory:` is accepted for tests/scaffolds). */
  readonly databasePath?: string;
  /** History table name used by this migrate config. */
  readonly historyTable?: string;
  /** Default migration CLI logging settings; runtime flags may override them. */
  readonly logging?: SisalLogSettings;
}

/** Validates and normalizes a migration config (pure). */
export function defineConfig(config: MigrateConfig): MigrateConfig {
  if (typeof config.dir !== "string" || config.dir.trim().length === 0) {
    throw new MigrationError("Migration config requires a non-empty dir", {
      code: "MIGRATION_INVALID",
      details: { field: "dir" },
    });
  }

  if (config.provider !== undefined && config.provider !== "neon") {
    throw new MigrationError("Unknown migration provider", {
      code: "MIGRATION_INVALID",
      details: { provider: config.provider },
    });
  }

  const logging = normalizeConfigLogging(config.logging);

  return Object.freeze({
    dir: config.dir.trim(),
    ...(config.dialect === undefined ? {} : { dialect: config.dialect }),
    ...(config.provider === undefined ? {} : { provider: config.provider }),
    ...(config.snapshot === undefined
      ? {}
      : { snapshot: normalizeSchemaSnapshot(config.snapshot) }),
    ...(config.databaseUrl === undefined
      ? {}
      : { databaseUrl: config.databaseUrl }),
    ...(config.databaseAuthToken === undefined
      ? {}
      : { databaseAuthToken: config.databaseAuthToken }),
    ...(config.databasePath === undefined
      ? {}
      : { databasePath: config.databasePath }),
    ...(config.historyTable === undefined
      ? {}
      : { historyTable: config.historyTable }),
    ...(logging === undefined ? {} : { logging }),
  });
}

function normalizeConfigLogging(
  logging: SisalLogSettings | undefined,
): SisalLogSettings | undefined {
  if (logging === undefined) {
    return undefined;
  }

  if (typeof logging !== "object" || logging === null) {
    throw new MigrationError("Migration config logging must be an object", {
      code: "MIGRATION_INVALID",
      details: { field: "logging" },
    });
  }

  if (logging.level !== undefined && !isSisalLogLevel(logging.level)) {
    throw new MigrationError("Unknown logging level", {
      code: "MIGRATION_INVALID",
      details: { level: logging.level },
    });
  }

  const categories = normalizeConfigLogCategories(logging.categories);
  const sql = normalizeConfigSqlLogging(logging.sql);

  return {
    ...(logging.level === undefined ? {} : { level: logging.level }),
    ...(categories === undefined ? {} : { categories }),
    ...(sql === undefined ? {} : { sql }),
  };
}

function normalizeConfigLogCategories(
  categories: SisalLogSettings["categories"],
): SisalLogSettings["categories"] {
  if (categories === undefined) {
    return undefined;
  }

  if (typeof categories !== "object" || categories === null) {
    throw new MigrationError(
      "Migration config logging categories must be an object",
      {
        code: "MIGRATION_INVALID",
        details: { field: "logging.categories" },
      },
    );
  }

  const normalized: NonNullable<SisalLogSettings["categories"]> = {};
  for (const [category, value] of Object.entries(categories)) {
    if (!isSisalLogCategory(category)) {
      throw new MigrationError("Unknown logging category", {
        code: "MIGRATION_INVALID",
        details: { category },
      });
    }

    if (typeof value === "boolean") {
      normalized[category] = value;
      continue;
    }

    if (!isSisalLogLevel(value)) {
      throw new MigrationError("Unknown logging category level", {
        code: "MIGRATION_INVALID",
        details: { category, level: value },
      });
    }

    normalized[category] = value;
  }

  return normalized;
}

function normalizeConfigSqlLogging(
  sql: SisalLogSettings["sql"],
): SisalLogSettings["sql"] {
  if (sql === undefined) {
    return undefined;
  }

  if (typeof sql !== "object" || sql === null) {
    throw new MigrationError("Migration config logging.sql must be an object", {
      code: "MIGRATION_INVALID",
      details: { field: "logging.sql" },
    });
  }

  if (
    sql.parameters !== undefined &&
    sql.parameters !== "off" &&
    sql.parameters !== "redacted"
  ) {
    throw new MigrationError("Unknown SQL parameter logging mode", {
      code: "MIGRATION_INVALID",
      details: { parameters: sql.parameters },
    });
  }

  return {
    ...(sql.parameters === undefined ? {} : { parameters: sql.parameters }),
  };
}

/** Drift categories reported by {@link checkDrift}. */
export type DriftKind =
  | "schema_changed"
  | "pending_migrations"
  | "missing_snapshot";

/** A single drift finding from {@link checkDrift}. */
export interface DriftFinding {
  /** message for this drift finding. */
  readonly kind: DriftKind;
  /** message for this drift finding. */
  readonly message: string;
}

/** Result of a drift check. */
export interface DriftReport {
  /** findings for this drift report. */
  readonly clean: boolean;
  /** findings for this drift report. */
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

/** The subset of `node:fs/promises` the Node filesystem uses. */
interface NodeFsApi {
  readdir(
    path: string,
    options: { withFileTypes: true },
  ): Promise<ReadonlyArray<{ name: string; isFile(): boolean }>>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
}

/** True when `error` is a Node "no such file or directory" error. */
function isNodeNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as { code?: unknown }).code === "ENOENT";
}

/**
 * {@link MigrationFileSystem} backed by `node:fs/promises`, for running the
 * `sisal` CLI (and the migration workflow) on Node. `node:fs/promises` is
 * imported lazily on first use so the module loads under Deno untouched;
 * {@link defaultMigrationFileSystem} selects it automatically off Deno.
 */
export function nodeMigrationFileSystem(): MigrationFileSystem {
  let fsPromise: Promise<NodeFsApi> | undefined;
  const getFs =
    () => (fsPromise ??= import("node:fs/promises") as unknown as Promise<
      NodeFsApi
    >);

  return {
    async readDir(path: string): Promise<readonly string[]> {
      const fs = await getFs();
      try {
        const entries = await fs.readdir(path, { withFileTypes: true });
        return entries.filter((entry) => entry.isFile()).map((e) => e.name);
      } catch (cause) {
        if (isNodeNotFound(cause)) return [];
        throw cause;
      }
    },

    async readFile(path: string): Promise<string | undefined> {
      const fs = await getFs();
      try {
        return await fs.readFile(path, "utf8");
      } catch (cause) {
        if (isNodeNotFound(cause)) return undefined;
        throw cause;
      }
    },

    async writeFile(path: string, content: string): Promise<void> {
      const fs = await getFs();
      await fs.writeFile(path, content, "utf8");
    },

    async mkdir(path: string): Promise<void> {
      const fs = await getFs();
      await fs.mkdir(path, { recursive: true });
    },
  };
}

/**
 * The {@link MigrationFileSystem} for the host runtime: Deno file APIs under
 * Deno ({@link denoMigrationFileSystem}), `node:fs/promises` otherwise
 * ({@link nodeMigrationFileSystem}). The `sisal` CLI uses this so it runs on
 * both runtimes without the caller choosing.
 */
export function defaultMigrationFileSystem(): MigrationFileSystem {
  const deno = (globalThis as { readonly Deno?: unknown }).Deno;
  return deno === undefined
    ? nodeMigrationFileSystem()
    : denoMigrationFileSystem();
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}
