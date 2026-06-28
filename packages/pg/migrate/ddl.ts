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
  type SisalIndexColumnSnapshot,
  type SisalSchemaSnapshot,
  type SisalTableSnapshot,
} from "@sisal/orm";
import { planSchemaChangesFromDiff, type SchemaChange } from "@sisal/migrate";

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

  for (const unique of table.uniqueConstraints ?? []) {
    if (unique.columns.length === 0) continue;
    const columns = unique.columns.map(quotePgIdent).join(", ");
    const name = unique.name === undefined
      ? ""
      : `CONSTRAINT ${quotePgIdent(unique.name)} `;
    lines.push(`  ${name}UNIQUE (${columns})`);
  }

  for (const check of table.checks ?? []) {
    if (check.expression.trim().length === 0) continue;
    const name = check.name === undefined
      ? ""
      : `CONSTRAINT ${quotePgIdent(check.name)} `;
    lines.push(`  ${name}CHECK (${check.expression})`);
  }

  return `CREATE TABLE ${pgQualifiedName(table)} (\n${lines.join(",\n")}\n);`;
}

/** Default index name when one is not provided (`table_col1_col2_idx`). */
function pgIndexName(
  table: string,
  columns: readonly SisalIndexColumnSnapshot[],
): string {
  return `${table}_${columns.map((column) => column.value).join("_")}_idx`;
}

/** Renders one index key: a quoted column or a raw expression, plus direction. */
function renderPgIndexColumn(column: SisalIndexColumnSnapshot): string {
  const base = column.expression === true
    ? `(${column.value})`
    : quotePgIdent(column.value);
  if (column.direction === "desc") return `${base} DESC`;
  if (column.direction === "asc") return `${base} ASC`;
  return base;
}

/** Generates `CREATE [UNIQUE] INDEX` statements for a table's indexes. */
export function generatePostgresIndexes(table: SisalTableSnapshot): string[] {
  return (table.indexes ?? [])
    .filter((index) => index.columns.length > 0)
    .map((index) => {
      const unique = index.unique === true ? "UNIQUE " : "";
      const columns = index.columns.map(renderPgIndexColumn).join(", ");
      const name = quotePgIdent(
        index.name ?? pgIndexName(table.name, index.columns),
      );
      const where = index.where === undefined || index.where.trim() === ""
        ? ""
        : ` WHERE ${index.where}`;
      return `CREATE ${unique}INDEX ${name} ON ${
        pgQualifiedName(table)
      } (${columns})${where};`;
    });
}

/** Maps a referential action to its SQL keyword (`cascade` → `CASCADE`). */
function pgReferentialAction(action: string): string {
  return action.toUpperCase();
}

/**
 * Generates `ALTER TABLE … ADD … FOREIGN KEY` statements for a table. Foreign
 * keys are emitted *after* every `CREATE TABLE` so the alphabetical table order
 * in a snapshot never produces a forward-reference error on Postgres.
 */
export function generatePostgresForeignKeys(
  table: SisalTableSnapshot,
): string[] {
  return (table.foreignKeys ?? [])
    .filter((fk) => fk.columns.length > 0)
    .map((fk) => {
      const columns = fk.columns.map(quotePgIdent).join(", ");
      const refTable = pgQualifiedName({
        name: fk.references.table,
        ...(fk.references.schema === undefined
          ? {}
          : { schema: fk.references.schema }),
      });
      const refColumns = fk.references.columns.map(quotePgIdent).join(", ");
      const name = fk.name === undefined
        ? ""
        : `CONSTRAINT ${quotePgIdent(fk.name)} `;
      let clause =
        `${name}FOREIGN KEY (${columns}) REFERENCES ${refTable} (${refColumns})`;
      if (fk.onDelete !== undefined) {
        clause += ` ON DELETE ${pgReferentialAction(fk.onDelete)}`;
      }
      if (fk.onUpdate !== undefined) {
        clause += ` ON UPDATE ${pgReferentialAction(fk.onUpdate)}`;
      }
      return `ALTER TABLE ${pgQualifiedName(table)} ADD ${clause};`;
    });
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

  // Foreign keys come after every CREATE TABLE so forward references resolve.
  for (const table of diff.addedTables) {
    statements.push(...generatePostgresForeignKeys(table));
  }

  for (const table of diff.addedTables) {
    statements.push(...generatePostgresIndexes(table));
  }

  const { destructive } = planSchemaChangesFromDiff(diff);

  return { statements, destructive };
}
