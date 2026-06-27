/**
 * Pure SQLite DDL generation from `@sisal/orm` snapshots.
 *
 * These helpers emit SQL strings only — they never open a connection or import
 * the `@db/sqlite` driver — so they are fully unit-testable. Destructive changes
 * (drop table/column, column type changes) are detected and returned
 * separately; SQLite has very limited `ALTER TABLE`, so they are never emitted
 * as ordinary migration SQL.
 *
 * @module
 */

import {
  diffSchemaSnapshots,
  type SisalColumnDefault,
  type SisalColumnSnapshot,
  type SisalColumnType,
  type SisalSchemaSnapshot,
  type SisalTableSnapshot,
} from "@sisal/orm";
import { planSchemaChangesFromDiff, type SchemaChange } from "@sisal/migrate";

/** Quotes a SQLite identifier, escaping embedded double quotes. */
export function quoteSqliteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Maps a snapshot column type to a SQLite type/affinity. SQLite is dynamically
 * typed with five affinities (`TEXT`/`INTEGER`/`REAL`/`NUMERIC`/`BLOB`); higher
 * level types map onto the closest one (dates/JSON/UUIDs → `TEXT`, booleans →
 * `INTEGER`). A snapshot's Postgres `dialectType` is intentionally ignored — it
 * belongs to a different dialect.
 */
export function generateSqliteColumnType(type: SisalColumnType): string {
  switch (type.kind) {
    case "integer":
    case "bigint":
    case "smallint":
    case "serial":
    case "bigserial":
    case "boolean":
      return "INTEGER";
    case "number":
    case "numeric":
    case "decimal":
    case "real":
    case "double":
    case "float":
      return "REAL";
    case "bytea":
    case "blob":
      return "BLOB";
    default:
      // text, varchar, char, uuid, json, jsonb, date, time, timestamp,
      // timestamptz, enum, and anything unknown all use TEXT affinity.
      return "TEXT";
  }
}

function renderSqliteDefault(value: SisalColumnDefault): string {
  if (value.kind === "expression") {
    return value.sql;
  }

  if (value.value === null) {
    return "NULL";
  }

  if (typeof value.value === "boolean") {
    return value.value ? "1" : "0";
  }

  if (typeof value.value === "string") {
    return `'${value.value.replace(/'/g, "''")}'`;
  }

  return String(value.value);
}

/** Renders a single column definition for `CREATE TABLE` / `ADD COLUMN`. */
export function generateSqliteColumnDefinition(
  column: SisalColumnSnapshot,
): string {
  let definition = `${quoteSqliteIdent(column.name)} ${
    generateSqliteColumnType(column.type)
  }`;

  if (column.nullable === false) {
    definition += " NOT NULL";
  }

  if (column.default !== undefined) {
    definition += ` DEFAULT ${renderSqliteDefault(column.default)}`;
  }

  return definition;
}

/** Generates a `CREATE TABLE` statement for one snapshot table. */
export function generateSqliteCreateTable(
  table: SisalTableSnapshot,
): string {
  const lines = table.columns.map(
    (column) => `  ${generateSqliteColumnDefinition(column)}`,
  );

  if (table.primaryKey !== undefined && table.primaryKey.columns.length > 0) {
    const columns = table.primaryKey.columns.map(quoteSqliteIdent).join(", ");
    lines.push(`  PRIMARY KEY (${columns})`);
  }

  for (const unique of table.uniqueConstraints ?? []) {
    if (unique.columns.length === 0) continue;
    const columns = unique.columns.map(quoteSqliteIdent).join(", ");
    const name = unique.name === undefined
      ? ""
      : `CONSTRAINT ${quoteSqliteIdent(unique.name)} `;
    lines.push(`  ${name}UNIQUE (${columns})`);
  }

  for (const check of table.checks ?? []) {
    if (check.expression.trim().length === 0) continue;
    const name = check.name === undefined
      ? ""
      : `CONSTRAINT ${quoteSqliteIdent(check.name)} `;
    lines.push(`  ${name}CHECK (${check.expression})`);
  }

  // SQLite accepts forward references, so foreign keys can stay inline in the
  // CREATE TABLE (unlike Postgres, where they are added afterwards).
  for (const fk of table.foreignKeys ?? []) {
    if (fk.columns.length === 0) continue;
    const columns = fk.columns.map(quoteSqliteIdent).join(", ");
    const refColumns = fk.references.columns.map(quoteSqliteIdent).join(", ");
    let clause = `  FOREIGN KEY (${columns}) REFERENCES ${
      quoteSqliteIdent(fk.references.table)
    } (${refColumns})`;
    if (fk.onDelete !== undefined) {
      clause += ` ON DELETE ${fk.onDelete.toUpperCase()}`;
    }
    if (fk.onUpdate !== undefined) {
      clause += ` ON UPDATE ${fk.onUpdate.toUpperCase()}`;
    }
    lines.push(clause);
  }

  // SQLite ignores any schema qualifier; tables live in one namespace.
  return `CREATE TABLE ${quoteSqliteIdent(table.name)} (\n${
    lines.join(",\n")
  }\n);`;
}

/** Default index name when one is not provided (`table_col1_col2_idx`). */
function sqliteIndexName(table: string, columns: readonly string[]): string {
  return `${table}_${columns.join("_")}_idx`;
}

/** Generates `CREATE [UNIQUE] INDEX` statements for a table's indexes. */
export function generateSqliteIndexes(table: SisalTableSnapshot): string[] {
  return (table.indexes ?? [])
    .filter((index) => index.columns.length > 0)
    .map((index) => {
      const unique = index.unique === true ? "UNIQUE " : "";
      const columns = index.columns.map(quoteSqliteIdent).join(", ");
      const name = quoteSqliteIdent(
        index.name ?? sqliteIndexName(table.name, index.columns),
      );
      return `CREATE ${unique}INDEX ${name} ON ${
        quoteSqliteIdent(table.name)
      } (${columns});`;
    });
}

/** Generates an `ALTER TABLE ... ADD COLUMN` statement. */
export function generateSqliteAddColumn(
  table: { readonly name: string },
  column: SisalColumnSnapshot,
): string {
  return `ALTER TABLE ${quoteSqliteIdent(table.name)} ADD COLUMN ${
    generateSqliteColumnDefinition(column)
  };`;
}

/** Safe (additive) up statements plus the destructive changes that were withheld. */
export interface SqliteUpStatements {
  readonly statements: readonly string[];
  readonly destructive: readonly SchemaChange[];
}

/**
 * Generates the **non-destructive** SQLite `up` statements for migrating
 * `from` → `to`: `CREATE TABLE` for new tables and `ALTER TABLE ADD COLUMN` for
 * new columns. Destructive changes (drop table/column, column type changes) are
 * never emitted; they are returned in `destructive` for the caller to handle
 * explicitly (often via the SQLite 12-step table rebuild). A missing `from`
 * treats every table as newly created.
 */
export function generateSqliteUpStatements(
  to: SisalSchemaSnapshot,
  from?: SisalSchemaSnapshot,
): SqliteUpStatements {
  const diff = diffSchemaSnapshots(
    from ?? { version: to.version, tables: [] },
    to,
  );
  const statements: string[] = [];

  for (const table of diff.addedTables) {
    statements.push(generateSqliteCreateTable(table));
  }

  for (const table of diff.changedTables) {
    for (const column of table.columns.added) {
      statements.push(generateSqliteAddColumn(table, column));
    }
  }

  for (const table of diff.addedTables) {
    statements.push(...generateSqliteIndexes(table));
  }

  const { destructive } = planSchemaChangesFromDiff(diff);

  return { statements, destructive };
}
