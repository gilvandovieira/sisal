/**
 * Pure PostgreSQL DDL generation from `@sisal/orm` snapshots.
 *
 * These helpers emit SQL strings only — they never open a connection or import
 * the `@db/postgres` driver — so they are fully unit-testable. Destructive
 * changes (drop table/column, column type changes) are detected and returned
 * separately; they are never emitted as ordinary migration SQL.
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
import { planSchemaChanges, type SchemaChange } from "@sisal/migrate";

/** Quotes a PostgreSQL identifier, escaping embedded double quotes. */
export function quotePgIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Renders the qualified, quoted `"schema"."table"` name. */
export function pgQualifiedName(table: {
  readonly name: string;
  readonly schema?: string;
}): string {
  return table.schema === undefined
    ? quotePgIdent(table.name)
    : `${quotePgIdent(table.schema)}.${quotePgIdent(table.name)}`;
}

/** Maps a snapshot column type to a PostgreSQL type expression. */
export function generatePostgresColumnType(type: SisalColumnType): string {
  const base = pgBaseType(type);
  return type.array === true ? `${base}[]` : base;
}

function pgBaseType(type: SisalColumnType): string {
  if (type.dialectType !== undefined) {
    return type.dialectType;
  }

  switch (type.kind) {
    case "varchar":
      return type.length === undefined ? "varchar" : `varchar(${type.length})`;
    case "char":
      return type.length === undefined ? "char" : `char(${type.length})`;
    case "numeric":
    case "decimal":
      if (type.precision === undefined) {
        return "numeric";
      }
      return type.scale === undefined
        ? `numeric(${type.precision})`
        : `numeric(${type.precision}, ${type.scale})`;
    case "double":
    case "float":
      return "double precision";
    case "timestamp":
      return "timestamptz";
    default:
      return type.kind;
  }
}

function renderPgDefault(value: SisalColumnDefault): string {
  if (value.kind === "expression") {
    return value.sql;
  }

  if (value.value === null) {
    return "NULL";
  }

  if (typeof value.value === "string") {
    return `'${value.value.replace(/'/g, "''")}'`;
  }

  return String(value.value);
}

/** Renders a single column definition for `CREATE TABLE` / `ADD COLUMN`. */
export function generatePostgresColumnDefinition(
  column: SisalColumnSnapshot,
): string {
  let definition = `${quotePgIdent(column.name)} ${
    generatePostgresColumnType(column.type)
  }`;

  if (column.nullable === false) {
    definition += " NOT NULL";
  }

  if (column.default !== undefined) {
    definition += ` DEFAULT ${renderPgDefault(column.default)}`;
  }

  return definition;
}

/** Generates a `CREATE TABLE` statement for one snapshot table. */
export function generatePostgresCreateTable(
  table: SisalTableSnapshot,
): string {
  const lines = table.columns.map(
    (column) => `  ${generatePostgresColumnDefinition(column)}`,
  );

  if (table.primaryKey !== undefined && table.primaryKey.columns.length > 0) {
    const columns = table.primaryKey.columns.map(quotePgIdent).join(", ");
    lines.push(`  PRIMARY KEY (${columns})`);
  }

  return `CREATE TABLE ${pgQualifiedName(table)} (\n${lines.join(",\n")}\n);`;
}

/** Generates an `ALTER TABLE ... ADD COLUMN` statement. */
export function generatePostgresAddColumn(
  table: { readonly name: string; readonly schema?: string },
  column: SisalColumnSnapshot,
): string {
  return `ALTER TABLE ${pgQualifiedName(table)} ADD COLUMN ${
    generatePostgresColumnDefinition(column)
  };`;
}

/** Safe (additive) up statements plus the destructive changes that were withheld. */
export interface PostgresUpStatements {
  readonly statements: readonly string[];
  readonly destructive: readonly SchemaChange[];
}

/**
 * Generates the **non-destructive** PostgreSQL `up` statements for migrating
 * `from` → `to`: `CREATE TABLE` for new tables and `ALTER TABLE ADD COLUMN` for
 * new columns. Destructive changes (drop table/column, column type changes) are
 * never emitted; they are returned in `destructive` for the caller to handle
 * explicitly. A missing `from` treats every table as newly created.
 */
export function generatePostgresUpStatements(
  to: SisalSchemaSnapshot,
  from?: SisalSchemaSnapshot,
): PostgresUpStatements {
  const diff = diffSchemaSnapshots(
    from ?? { version: to.version, tables: [] },
    to,
  );
  const statements: string[] = [];

  for (const table of diff.addedTables) {
    statements.push(generatePostgresCreateTable(table));
  }

  for (const table of diff.changedTables) {
    for (const column of table.columns.added) {
      statements.push(generatePostgresAddColumn(table, column));
    }
  }

  const { destructive } = planSchemaChanges(
    from === undefined ? { to } : { from, to },
  );

  return { statements, destructive };
}
