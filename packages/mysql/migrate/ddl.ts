/**
 * Pure MySQL/MariaDB DDL generation from `@sisal/orm` snapshots.
 *
 * These helpers emit SQL strings only — they never open a connection or import
 * a driver — so they are fully unit-testable. Destructive changes (drop
 * table/column, column type changes) are detected and returned separately;
 * they are never emitted as ordinary migration SQL.
 *
 * Every mapping and rule here implements `docs/mysql-ddl-mapping.md` (the C4
 * report), probe-verified against MySQL 8.4 and MariaDB 11.8. The generator
 * targets the strictest common denominator of both engines (floor: MySQL
 * 8.0.16 / MariaDB 10.10) and **fails closed at generation time** on the
 * constructs one engine would reject at apply time: a keyless or duplicated
 * `AUTO_INCREMENT` column, a `TEXT`/`BLOB`/`JSON` key (MySQL requires a
 * prefix length the snapshot cannot express — use `varchar(n)`), and partial
 * (`WHERE`) indexes. Functional (expression) indexes are emitted on a detected
 * base MySQL ≥ 8.0.13 and fail closed otherwise (below the floor, MariaDB, or
 * an unknown version).
 *
 * @module
 */

import {
  capabilitySupported,
  DIALECT_CAPABILITIES,
  type DialectIdentity,
  diffSchemaSnapshots,
  OrmError,
  selectSchemaObjects,
  type SisalColumnDefault,
  type SisalColumnSnapshot,
  type SisalColumnType,
  type SisalIndexColumnSnapshot,
  type SisalSchemaSnapshot,
  type SisalTableSnapshot,
} from "@sisal/orm";
import { planSchemaChangesFromDiff, type SchemaChange } from "@sisal/migrate";

/** Quotes a MySQL identifier with backticks, escaping embedded backticks. */
export function quoteMysqlIdent(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

/**
 * Renders the qualified, quoted `` `schema`.`table` `` name. MySQL treats a
 * schema qualifier as a database qualifier — the two concepts coincide.
 */
export function mysqlQualifiedName(table: {
  readonly name: string;
  readonly schema?: string;
}): string {
  return table.schema === undefined
    ? quoteMysqlIdent(table.name)
    : `${quoteMysqlIdent(table.schema)}.${quoteMysqlIdent(table.name)}`;
}

/**
 * Maps a snapshot column type to a MySQL type expression, per the
 * probe-verified table in `docs/mysql-ddl-mapping.md`: `real` is an explicit
 * `FLOAT` (MySQL's `REAL` means `DOUBLE`), `timestamp` is `DATETIME(6)` (no
 * timezone conversion, no 2038 cliff), `timestamptz` is `TIMESTAMP(6)`,
 * `uuid` is `CHAR(36)`, `bytea` is `LONGBLOB` (plain `BLOB` caps at 64 KB),
 * and `.array()` columns serialize to `JSON` (no native array type). A
 * `dialectType` is emitted verbatim — the same trusted escape hatch
 * (SEC-006) as on pg.
 */
export function generateMysqlColumnType(type: SisalColumnType): string {
  if (type.dialectType !== undefined) {
    return type.dialectType;
  }

  if (type.array === true) {
    return "JSON";
  }

  switch (type.kind) {
    case "varchar":
      // MySQL requires a length; 255 keeps the column indexable everywhere.
      return `VARCHAR(${type.length ?? 255})`;
    case "char":
      return type.length === undefined ? "CHAR" : `CHAR(${type.length})`;
    case "integer":
      return "INT";
    case "smallint":
      return "SMALLINT";
    case "bigint":
      return "BIGINT";
    case "serial":
      return "INT";
    case "bigserial":
      return "BIGINT";
    case "numeric":
    case "decimal":
      if (type.precision === undefined) {
        return "DECIMAL";
      }
      return type.scale === undefined
        ? `DECIMAL(${type.precision})`
        : `DECIMAL(${type.precision}, ${type.scale})`;
    case "real":
      return "FLOAT";
    case "number":
    case "double":
    case "float":
      return "DOUBLE";
    case "boolean":
      return "BOOLEAN";
    case "json":
    case "jsonb":
      return "JSON";
    case "date":
      return "DATE";
    case "time":
      return "TIME(6)";
    case "timestamp":
      return "DATETIME(6)";
    case "timestamptz":
      return "TIMESTAMP(6)";
    case "bytea":
    case "blob":
      return "LONGBLOB";
    case "uuid":
      return "CHAR(36)";
    default:
      // text, enum, and anything unknown map to TEXT — the conservative
      // choice: the TEXT rules below (no keys, paren-only defaults) then
      // apply, so an unexpected kind fails closed instead of mis-applying.
      return "TEXT";
  }
}

function isAutoIncrementColumn(column: SisalColumnSnapshot): boolean {
  return column.type.dialectType === undefined &&
    (column.type.kind === "serial" || column.type.kind === "bigserial");
}

// TEXT/BLOB columns cannot be keys without a prefix length, cannot take a
// bare literal default on MySQL, and JSON columns cannot be keys at all.
// Matched against the *emitted* type so `dialectType: "MEDIUMTEXT"` is
// covered too, while `dialectType: "VARCHAR(500)"` on a `text` kind is not.
function isTextBlobOrJsonType(sqlType: string): boolean {
  return /^((TINY|MEDIUM|LONG)?(TEXT|BLOB)|JSON)\b/i.test(sqlType);
}

function renderMysqlDefault(
  value: SisalColumnDefault,
  sqlType: string,
): string {
  if (value.kind === "expression") {
    // Parenthesized expression defaults (MySQL 8.0.13+) are the portable
    // form — probe-verified on both engines.
    return `(${value.sql})`;
  }

  if (value.value === null) {
    return "NULL";
  }

  if (typeof value.value === "boolean") {
    return value.value ? "1" : "0";
  }

  const literal = typeof value.value === "string"
    ? `'${value.value.replace(/'/g, "''")}'`
    : String(value.value);

  // MySQL rejects bare literal defaults on TEXT/BLOB/JSON columns; the
  // paren-expression form is accepted by both engines (probe-verified).
  return isTextBlobOrJsonType(sqlType) ? `(${literal})` : literal;
}

/** Renders a single column definition for `CREATE TABLE` / `ADD COLUMN`. */
export function generateMysqlColumnDefinition(
  column: SisalColumnSnapshot,
): string {
  const sqlType = generateMysqlColumnType(column.type);
  let definition = `${quoteMysqlIdent(column.name)} ${sqlType}`;

  if (column.generatedAs !== undefined) {
    // MySQL/MariaDB support both STORED and VIRTUAL generated columns; the
    // generation clause replaces the DEFAULT/AUTO_INCREMENT slot.
    const kind = column.generatedAs.stored ? "STORED" : "VIRTUAL";
    definition += ` GENERATED ALWAYS AS (${column.generatedAs.sql}) ${kind}`;
    if (column.nullable === false) {
      definition += " NOT NULL";
    }
    return definition;
  }

  if (isAutoIncrementColumn(column)) {
    definition += " NOT NULL AUTO_INCREMENT";
  } else if (column.nullable === false) {
    definition += " NOT NULL";
  } else if (
    column.type.dialectType === undefined &&
    column.type.kind === "timestamptz"
  ) {
    // Explicit NULL documents nullability against legacy implicit
    // NOT NULL DEFAULT CURRENT_TIMESTAMP modes.
    definition += " NULL";
  }

  if (column.default !== undefined) {
    definition += ` DEFAULT ${renderMysqlDefault(column.default, sqlType)}`;
  }

  return definition;
}

// Every name appearing anywhere in a key (a TEXT/BLOB/JSON column must
// avoid all of these positions).
function keyColumnNames(table: SisalTableSnapshot): Set<string> {
  const names = new Set<string>(table.primaryKey?.columns ?? []);
  for (const unique of table.uniqueConstraints ?? []) {
    for (const name of unique.columns) names.add(name);
  }
  for (const index of table.indexes ?? []) {
    for (const column of index.columns) {
      if (column.expression !== true) names.add(column.value);
    }
  }
  return names;
}

// The names leading a key. InnoDB (both engines' default) requires an
// AUTO_INCREMENT column to be the *first* column of some key — membership
// in a composite key's tail is rejected at apply time.
function leadingKeyColumnNames(table: SisalTableSnapshot): Set<string> {
  const names = new Set<string>();
  const first = table.primaryKey?.columns[0];
  if (first !== undefined) names.add(first);
  for (const unique of table.uniqueConstraints ?? []) {
    if (unique.columns[0] !== undefined) names.add(unique.columns[0]);
  }
  for (const index of table.indexes ?? []) {
    const column = index.columns[0];
    if (column !== undefined && column.expression !== true) {
      names.add(column.value);
    }
  }
  return names;
}

function validateMysqlTable(table: SisalTableSnapshot): void {
  const keyed = keyColumnNames(table);
  const leading = leadingKeyColumnNames(table);

  const autoIncrement = table.columns.filter(isAutoIncrementColumn);
  if (autoIncrement.length > 1) {
    throw new OrmError(
      `Table "${table.name}" defines ${autoIncrement.length} serial/bigserial columns; MySQL allows at most one AUTO_INCREMENT column per table.`,
      { code: "ORM_DIALECT_UNSUPPORTED" },
    );
  }
  for (const column of autoIncrement) {
    if (!leading.has(column.name)) {
      throw new OrmError(
        `Column "${table.name}"."${column.name}" is serial/bigserial but does not lead a key; InnoDB requires an AUTO_INCREMENT column to be the first column of a primary key, unique constraint, or index.`,
        { code: "ORM_DIALECT_UNSUPPORTED" },
      );
    }
  }

  for (const column of table.columns) {
    const sqlType = generateMysqlColumnType(column.type);
    if (keyed.has(column.name) && isTextBlobOrJsonType(sqlType)) {
      throw new OrmError(
        `Column "${table.name}"."${column.name}" maps to ${sqlType} but is used as a key; MySQL requires a prefix length the snapshot cannot express — use varchar(n) instead.`,
        { code: "ORM_DIALECT_UNSUPPORTED" },
      );
    }
  }
}

/**
 * Generates a `CREATE TABLE` statement for one snapshot table. No
 * `ENGINE`/`CHARSET` clause is emitted — both modern engines default to
 * InnoDB + utf8mb4, and explicit collation names differ per engine
 * (`utf8mb4_0900_ai_ci` is MySQL-only), so server defaults win.
 *
 * Throws an `OrmError` (`ORM_DIALECT_UNSUPPORTED`) when the table breaks a
 * rule both engines enforce at apply time: more than one serial/bigserial
 * column, a serial/bigserial column that is not a key, or a
 * `TEXT`/`BLOB`/`JSON`-mapped column used as a key.
 */
export function generateMysqlCreateTable(table: SisalTableSnapshot): string {
  validateMysqlTable(table);

  const lines = table.columns.map(
    (column) => `  ${generateMysqlColumnDefinition(column)}`,
  );

  if (table.primaryKey !== undefined && table.primaryKey.columns.length > 0) {
    const columns = table.primaryKey.columns.map(quoteMysqlIdent).join(", ");
    lines.push(`  PRIMARY KEY (${columns})`);
  }

  for (const unique of table.uniqueConstraints ?? []) {
    if (unique.columns.length === 0) continue;
    const columns = unique.columns.map(quoteMysqlIdent).join(", ");
    const name = unique.name === undefined
      ? ""
      : `CONSTRAINT ${quoteMysqlIdent(unique.name)} `;
    lines.push(`  ${name}UNIQUE (${columns})`);
  }

  for (const check of table.checks ?? []) {
    if (check.expression.trim().length === 0) continue;
    const name = check.name === undefined
      ? ""
      : `CONSTRAINT ${quoteMysqlIdent(check.name)} `;
    lines.push(`  ${name}CHECK (${check.expression})`);
  }

  return `CREATE TABLE ${mysqlQualifiedName(table)} (\n${
    lines.join(",\n")
  }\n);`;
}

/** Default index name when one is not provided (`table_col1_col2_idx`). */
function mysqlIndexName(
  table: string,
  columns: readonly SisalIndexColumnSnapshot[],
): string {
  return `${table}_${columns.map((column) => column.value).join("_")}_idx`;
}

function renderMysqlIndexColumn(
  table: string,
  column: SisalIndexColumnSnapshot,
  identity: DialectIdentity,
): string {
  if (column.expression === true) {
    // Functional indexes light on base MySQL ≥ 8.0.13 (the `functionalIndex`
    // capability's base-engine version gate); MariaDB has none, and a
    // version-unknown identity fails closed.
    if (!capabilitySupported(DIALECT_CAPABILITIES.functionalIndex, identity)) {
      throw new OrmError(
        `Index on "${table}" uses an expression column (${column.value}); functional (expression) indexes need MySQL ≥ 8.0.13 (MariaDB has none — use a generated column).`,
        { code: "ORM_DIALECT_UNSUPPORTED" },
      );
    }
    // MySQL 8.0.13+ functional key part: the expression wrapped in parens.
    const expr = `(${column.value})`;
    if (column.direction === "desc") return `${expr} DESC`;
    if (column.direction === "asc") return `${expr} ASC`;
    return expr;
  }
  const base = quoteMysqlIdent(column.value);
  if (column.direction === "desc") return `${base} DESC`;
  if (column.direction === "asc") return `${base} ASC`;
  return base;
}

/**
 * Generates `CREATE [UNIQUE] INDEX` statements for a table's indexes.
 *
 * Partial indexes (`WHERE`) throw an `OrmError` (`ORM_DIALECT_UNSUPPORTED`) —
 * unsupported by both engines. Functional (expression) indexes are emitted on a
 * detected **base MySQL ≥ 8.0.13** `identity` and throw below that / on MariaDB
 * / when the version is unknown (`identity` defaults to a version-less base
 * MySQL, which fails closed).
 */
export function generateMysqlIndexes(
  table: SisalTableSnapshot,
  identity: DialectIdentity = { dialect: "mysql" },
): string[] {
  return (table.indexes ?? [])
    .filter((index) => index.columns.length > 0)
    .map((index) => {
      // Index-limit facts are declared once in the core capability registry
      // (`partialIndex`, `functionalIndex`); the generator reads them rather
      // than hard-coding. Partial indexes are unsupported family-wide.
      if (
        index.where !== undefined && index.where.trim() !== "" &&
        !capabilitySupported(DIALECT_CAPABILITIES.partialIndex, identity)
      ) {
        throw new OrmError(
          `Index "${
            index.name ?? mysqlIndexName(table.name, index.columns)
          }" on "${table.name}" has a WHERE clause; neither MySQL nor MariaDB supports partial indexes.`,
          { code: "ORM_DIALECT_UNSUPPORTED" },
        );
      }
      const unique = index.unique === true ? "UNIQUE " : "";
      const columns = index.columns
        .map((column) => renderMysqlIndexColumn(table.name, column, identity))
        .join(", ");
      const name = quoteMysqlIdent(
        index.name ?? mysqlIndexName(table.name, index.columns),
      );
      return `CREATE ${unique}INDEX ${name} ON ${
        mysqlQualifiedName(table)
      } (${columns});`;
    });
}

/** Maps a referential action to its SQL keyword (`cascade` → `CASCADE`). */
function mysqlReferentialAction(action: string): string {
  return action.toUpperCase();
}

/**
 * Generates `ALTER TABLE … ADD … FOREIGN KEY` statements for a table.
 * Foreign keys are emitted **after** every `CREATE TABLE` — never inline —
 * because MySQL silently ignores an inline column `REFERENCES` clause while
 * MariaDB honors it (probe-verified), so inline emission would create
 * schemas that differ silently per engine.
 */
export function generateMysqlForeignKeys(
  table: SisalTableSnapshot,
): string[] {
  return (table.foreignKeys ?? [])
    .filter((fk) => fk.columns.length > 0)
    .map((fk) => {
      const columns = fk.columns.map(quoteMysqlIdent).join(", ");
      const refTable = mysqlQualifiedName({
        name: fk.references.table,
        ...(fk.references.schema === undefined
          ? {}
          : { schema: fk.references.schema }),
      });
      const refColumns = fk.references.columns.map(quoteMysqlIdent).join(", ");
      const name = fk.name === undefined
        ? ""
        : `CONSTRAINT ${quoteMysqlIdent(fk.name)} `;
      let clause =
        `${name}FOREIGN KEY (${columns}) REFERENCES ${refTable} (${refColumns})`;
      if (fk.onDelete !== undefined) {
        clause += ` ON DELETE ${mysqlReferentialAction(fk.onDelete)}`;
      }
      if (fk.onUpdate !== undefined) {
        clause += ` ON UPDATE ${mysqlReferentialAction(fk.onUpdate)}`;
      }
      return `ALTER TABLE ${mysqlQualifiedName(table)} ADD ${clause};`;
    });
}

/**
 * Generates an `ALTER TABLE ... ADD COLUMN` statement.
 *
 * Throws an `OrmError` (`ORM_DIALECT_UNSUPPORTED`) for serial/bigserial
 * columns: the additive generator never emits key changes, and MySQL
 * rejects a keyless `AUTO_INCREMENT` column at apply time.
 */
export function generateMysqlAddColumn(
  table: { readonly name: string; readonly schema?: string },
  column: SisalColumnSnapshot,
): string {
  if (isAutoIncrementColumn(column)) {
    throw new OrmError(
      `Column "${table.name}"."${column.name}" is serial/bigserial; adding an AUTO_INCREMENT column via ADD COLUMN needs a key change the additive generator never emits.`,
      { code: "ORM_DIALECT_UNSUPPORTED" },
    );
  }
  return `ALTER TABLE ${mysqlQualifiedName(table)} ADD COLUMN ${
    generateMysqlColumnDefinition(column)
  };`;
}

/** Safe (additive) up statements plus the destructive changes that were withheld. */
export interface MysqlUpStatements {
  readonly statements: readonly string[];
  readonly destructive: readonly SchemaChange[];
}

/**
 * Generates the **non-destructive** MySQL/MariaDB `up` statements for
 * migrating `from` → `to`: `CREATE TABLE` for new tables and
 * `ALTER TABLE ADD COLUMN` for new columns, then foreign keys (after every
 * `CREATE TABLE` so forward references resolve — and because MySQL silently
 * drops inline `REFERENCES`), then indexes, then `mysql`-dialect schema
 * objects. Destructive changes (drop table/column, column type changes) are
 * never emitted; they are returned in `destructive` for the caller to handle
 * explicitly. A missing `from` treats every table as newly created.
 */
export function generateMysqlUpStatements(
  to: SisalSchemaSnapshot,
  from?: SisalSchemaSnapshot,
): MysqlUpStatements {
  const diff = diffSchemaSnapshots(
    from ?? { version: to.version, tables: [] },
    to,
  );
  // The snapshot carries the detected `(variant, version)`; feed it to the
  // index generator so functional indexes light on base MySQL ≥ 8.0.13.
  const identity: DialectIdentity = {
    dialect: "mysql",
    ...(to.dialectVariant === undefined ? {} : { variant: to.dialectVariant }),
    ...(to.dialectVersion === undefined ? {} : { version: to.dialectVersion }),
  };
  const statements: string[] = [];

  for (const table of diff.addedTables) {
    statements.push(generateMysqlCreateTable(table));
  }

  for (const table of diff.changedTables) {
    for (const column of table.columns.added) {
      statements.push(generateMysqlAddColumn(table, column));
    }
  }

  // Foreign keys come after every CREATE TABLE so forward references resolve.
  for (const table of diff.addedTables) {
    statements.push(...generateMysqlForeignKeys(table));
  }

  for (const table of diff.addedTables) {
    statements.push(...generateMysqlIndexes(table, identity));
  }

  // Stored DDL after table creation. Note for authors: MySQL has no
  // dollar-quoting and DELIMITER is a client artifact — a trigger/procedure
  // body must be a single statement.
  for (const object of selectSchemaObjects(to, from, "mysql")) {
    statements.push(object.up);
  }

  const { destructive } = planSchemaChangesFromDiff(diff);

  return { statements, destructive };
}
