import type {
  Database,
  SisalDialectName,
  SisalSchemaSnapshot,
} from "@sisal/orm";
import type {
  AppliedMigration,
  MigrationPlan,
  MigrationResult,
} from "@sisal/migrate";

export type IntegrationAdapterId =
  | "pg"
  | "neon"
  | "sqlite"
  | "libsql"
  | "mysql"
  | "mariadb";

export type IntegrationFamily = "postgres" | "sqlite" | "mysql";

export interface IntegrationCapabilities {
  readonly nativeIlike: boolean;
  readonly rightFullJoin: boolean;
  readonly returning: boolean;
  readonly upsert: boolean;
  readonly distinctOn: boolean;
  readonly rowLocking: boolean;
  readonly nativeArrays: boolean;
  readonly typedFunctions: boolean;
  readonly dataModifyingCte: boolean;
  /**
   * A `SELECT` CTE prefixed to a mutation (`WITH … UPDATE/DELETE/INSERT`).
   * MariaDB parses `WITH` only on `SELECT`, so it throws a typed guard there
   * while every other engine (including MySQL 8+) renders it.
   */
  readonly mutationCte: boolean;
  readonly schemaFunctions: boolean;
  readonly schemaTriggers: boolean;
  readonly richIndexes: boolean;
  readonly mutationUpdateFrom: boolean;
  readonly bareUpsertSelect: boolean;
}

export interface IntegrationValueShape {
  readonly boolean: "boolean" | "integer";
  readonly json: "parsed" | "text";
  /**
   * `jsonParsed` — no native array type, but the column maps to `JSON` and
   * the driver parses it back to a real array (MySQL proper); `jsonText` —
   * the same storage reads back as a JSON string (SQLite family, MariaDB).
   */
  readonly array: "native" | "jsonText" | "jsonParsed";
  readonly binary: "uint8array" | "arraybuffer";
  readonly numeric: "string" | "number";
  readonly dateTrunc: "timestamp" | "text";
}

export interface IntegrationUpStatements {
  readonly statements: readonly string[];
  readonly destructive: readonly unknown[];
}

export interface IntegrationMigratorOptions {
  readonly historyTable?: string;
  readonly splitStatements?: boolean;
  readonly useTransaction?: boolean;
  readonly [key: string]: unknown;
}

export interface IntegrationMigrator {
  migrate(
    options: { readonly migrations: readonly unknown[] },
  ): Promise<MigrationResult>;
  rollback(
    options: { readonly migrations: readonly unknown[] },
  ): Promise<MigrationResult>;
  plan(
    options: { readonly migrations: readonly unknown[] },
  ): Promise<MigrationPlan>;
  applied(): Promise<AppliedMigration[]>;
  close(): Promise<void>;
}

export interface IntegrationSqlHelpers {
  readonly supportsCascadeDrops: boolean;
  readonly metadataFlavor: "information_schema" | "pragma";
}

export interface IntegrationTarget {
  readonly id: IntegrationAdapterId;
  readonly label: string;
  readonly family: IntegrationFamily;
  readonly snapshotDialect: Extract<
    SisalDialectName,
    "postgres" | "sqlite" | "mysql"
  >;
  readonly ignore: boolean;

  db(): Promise<Database>;
  temporalDb(): Promise<Database>;
  close(): Promise<void>;

  generateUp(snapshot: SisalSchemaSnapshot): IntegrationUpStatements;
  migrator(options?: IntegrationMigratorOptions): Promise<IntegrationMigrator>;

  readonly capabilities: IntegrationCapabilities;
  readonly valueShape: IntegrationValueShape;
  readonly sql: IntegrationSqlHelpers;
}

export interface IntegrationScenario {
  readonly id: string;
  readonly name: string;
  run(target: IntegrationTarget): Promise<void> | void;
}

export function stripAdapterPrefix(name: string): string {
  return name.replace(/^[^:]+: /, "");
}

export function scenarioId(name: string): string {
  return stripAdapterPrefix(name)
    .toLowerCase()
    .replace(/[`$]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
