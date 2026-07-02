/**
 * Public entrypoint for @sisal/orm.
 *
 * This package defines the serializable schema snapshot contract shared by Sisal
 * database tooling. It intentionally has no Sisal dependencies.
 *
 * @module
 */

export const SCHEMA_SNAPSHOT_VERSION = 2 as const;

/** SQL dialect names understood by Sisal schema snapshots. */
export type SisalDialectName =
  | "generic"
  | "postgres"
  | "sqlite"
  | "mysql";

/** Serializable database schema snapshot shared by Sisal data packages. */
export interface SisalSchemaSnapshot {
  readonly version: typeof SCHEMA_SNAPSHOT_VERSION;
  readonly dialect?: SisalDialectName;
  /**
   * Engine variant behind `dialect` (e.g. `"mariadb"` for `mysql`) — the
   * snapshot half of the `(engine, variant, version)` dialect identity
   * decided in v0.6 (see `docs/mysql-readiness.md`). Optional and additive:
   * older snapshots without it mean "base engine".
   */
  readonly dialectVariant?: string;
  /** Minimum server version the snapshot's DDL targets (e.g. `"8.0.16"`). */
  readonly dialectVersion?: string;
  readonly tables: readonly SisalTableSnapshot[];
  /**
   * Raw, dialect-specific DDL fragments (functions, triggers, extensions, …)
   * emitted **after** table/column/constraint/index creation, in declared order.
   */
  readonly schemaObjects?: readonly SisalSchemaObjectSnapshot[];
  readonly metadata?: Record<string, unknown>;
}

/**
 * A raw, dialect-specific DDL fragment attached to a snapshot — a stored
 * function, trigger, extension, view, or any verbatim `CREATE …`. Emitted after
 * table creation, gated by {@link SisalSchemaObjectSnapshot.dialect}, so a
 * `defineTable` schema can carry the stored logic an app would otherwise keep in
 * a hand-written `.sql` migration.
 */
export interface SisalSchemaObjectSnapshot {
  /** Stable identity used for ordering, diffing, and drop generation. */
  readonly name: string;
  /** What the object is (documents intent; does not change rendering). */
  readonly kind: "function" | "trigger" | "extension" | "view" | "raw";
  /** Dialect this object targets; omit to emit for every dialect. */
  readonly dialect?: SisalDialectName;
  /** The `CREATE …` DDL emitted verbatim, after table creation. */
  readonly up: string;
  /** The matching `DROP …` DDL for the down migration. */
  readonly down?: string;
}

/** Serializable table definition inside a schema snapshot. */
export interface SisalTableSnapshot {
  readonly name: string;
  readonly schema?: string;
  readonly columns: readonly SisalColumnSnapshot[];
  readonly primaryKey?: SisalPrimaryKeySnapshot;
  readonly indexes?: readonly SisalIndexSnapshot[];
  readonly uniqueConstraints?: readonly SisalUniqueConstraintSnapshot[];
  readonly foreignKeys?: readonly SisalForeignKeySnapshot[];
  readonly checks?: readonly SisalCheckConstraintSnapshot[];
  readonly metadata?: Record<string, unknown>;
}

/** Serializable column definition inside a table snapshot. */
export interface SisalColumnSnapshot {
  readonly name: string;
  readonly type: SisalColumnType;
  readonly nullable?: boolean;
  readonly default?: SisalColumnDefault;
  readonly generated?: boolean;
  readonly references?: {
    readonly table: string;
    readonly schema?: string;
    readonly column: string;
    readonly onDelete?: string;
    readonly onUpdate?: string;
  };
  readonly metadata?: Record<string, unknown>;
}

/** Dialect-neutral column type descriptor. */
export interface SisalColumnType {
  readonly kind: string;
  readonly length?: number;
  readonly precision?: number;
  readonly scale?: number;
  readonly array?: boolean;
  /**
   * Raw, dialect-specific type emitted verbatim into DDL, overriding `kind`.
   *
   * **Trusted input.** This is an escape hatch for schema authors; it is never
   * sanitized. Only ever set it from developer-authored schema code, never from
   * a runtime/user value. See `docs/security.md` (SEC-006).
   */
  readonly dialectType?: string;
}

/**
 * Serializable column default value or expression.
 *
 * **`kind: "expression"` is a trusted input:** its `sql` is emitted verbatim
 * into the generated `DEFAULT` clause and is never sanitized. Set it only from
 * developer-authored schema code, never from a runtime/user value (literal
 * defaults are escaped; expression defaults are not). See `docs/security.md`
 * (SEC-006).
 */
export type SisalColumnDefault =
  | {
    readonly kind: "literal";
    readonly value: string | number | boolean | null;
  }
  | { readonly kind: "expression"; readonly sql: string };

/** Serializable primary-key constraint descriptor. */
export interface SisalPrimaryKeySnapshot {
  readonly name?: string;
  readonly columns: readonly string[];
  readonly metadata?: Record<string, unknown>;
}

/**
 * A single key in an index: a column or a raw SQL expression, with an optional
 * sort direction.
 */
export interface SisalIndexColumnSnapshot {
  /** Column physical name, or a raw SQL expression when `expression` is true. */
  readonly value: string;
  /** Sort direction for this key; omit for the dialect default (ascending). */
  readonly direction?: "asc" | "desc";
  /**
   * When true, `value` is a raw SQL expression emitted verbatim (an expression
   * index such as `lower("email")`); otherwise `value` is quoted as an
   * identifier.
   *
   * **Trusted input.** Expression text is emitted into DDL unsanitized — set it
   * only from developer-authored schema code. See `docs/security.md` (SEC-006).
   */
  readonly expression?: boolean;
}

/** Serializable index descriptor. */
export interface SisalIndexSnapshot {
  readonly name?: string;
  readonly columns: readonly SisalIndexColumnSnapshot[];
  readonly unique?: boolean;
  /**
   * Partial-index predicate, emitted verbatim as `WHERE <predicate>`.
   *
   * **Trusted input.** Emitted into DDL unsanitized — set it only from
   * developer-authored schema code. See `docs/security.md` (SEC-006).
   */
  readonly where?: string;
  readonly metadata?: Record<string, unknown>;
}

/** Serializable unique-constraint descriptor. */
export interface SisalUniqueConstraintSnapshot {
  readonly name?: string;
  readonly columns: readonly string[];
  readonly metadata?: Record<string, unknown>;
}

/** Serializable foreign-key constraint descriptor. */
export interface SisalForeignKeySnapshot {
  readonly name?: string;
  readonly columns: readonly string[];
  readonly references: {
    readonly table: string;
    readonly schema?: string;
    readonly columns: readonly string[];
  };
  readonly onDelete?: string;
  readonly onUpdate?: string;
  readonly metadata?: Record<string, unknown>;
}

/** Serializable check-constraint descriptor. */
export interface SisalCheckConstraintSnapshot {
  readonly name?: string;
  readonly expression: string;
  readonly metadata?: Record<string, unknown>;
}

/** Validation issue codes emitted by schema snapshot helpers. */
export type SisalSchemaIssueCode =
  | "SCHEMA_INVALID_VERSION"
  | "SCHEMA_INVALID_DIALECT"
  | "SCHEMA_INVALID_TABLE"
  | "SCHEMA_DUPLICATE_TABLE"
  | "SCHEMA_INVALID_COLUMN"
  | "SCHEMA_DUPLICATE_COLUMN"
  | "SCHEMA_UNKNOWN_COLUMN"
  | "SCHEMA_UNKNOWN_TARGET"
  | "SCHEMA_INVALID_CONSTRAINT"
  | (string & Record<never, never>);

/** One validation issue found in a schema snapshot. */
export interface SisalSchemaIssue {
  readonly code: SisalSchemaIssueCode;
  readonly path: string;
  readonly message: string;
}

const DIALECTS = new Set<SisalDialectName>([
  "generic",
  "postgres",
  "sqlite",
  "mysql",
]);

/** Normalizes and validates a schema snapshot. */
export function defineSchemaSnapshot(
  input: SisalSchemaSnapshot,
): SisalSchemaSnapshot {
  const snapshot = normalizeSchemaSnapshot(input);
  assertValidSchemaSnapshot(snapshot);
  return snapshot;
}

/**
 * Defines a raw DDL {@link SisalSchemaObjectSnapshot} — a stored function,
 * trigger, extension, or any verbatim `CREATE …` — to attach to a snapshot via
 * `createSchemaSnapshot({ tables, schemaObjects })`.
 */
export function defineSchemaObject(
  object: SisalSchemaObjectSnapshot,
): SisalSchemaObjectSnapshot {
  return normalizeSchemaObject(object);
}

function normalizeSchemaObject(
  object: SisalSchemaObjectSnapshot,
): SisalSchemaObjectSnapshot {
  return {
    name: object.name,
    kind: object.kind,
    ...(object.dialect === undefined ? {} : { dialect: object.dialect }),
    up: object.up,
    ...(object.down === undefined ? {} : { down: object.down }),
  };
}

/**
 * The schema objects to emit for `dialect` when migrating `from` → `to`: those
 * matching the dialect (or dialect-agnostic) and not byte-identical in `from`,
 * in declared order. Used by adapter DDL generators to append stored DDL after
 * table creation.
 */
export function selectSchemaObjects(
  to: SisalSchemaSnapshot,
  from: SisalSchemaSnapshot | undefined,
  dialect: SisalDialectName,
): readonly SisalSchemaObjectSnapshot[] {
  const previous = from?.schemaObjects ?? [];
  return (to.schemaObjects ?? []).filter((object) => {
    if (object.dialect !== undefined && object.dialect !== dialect) {
      return false;
    }
    return !previous.some((p) => p.name === object.name && p.up === object.up);
  });
}

/**
 * The `down` drop statements for a snapshot's `dialect` schema objects, in
 * reverse declared order (so dependents drop before their dependencies).
 */
export function schemaObjectDropStatements(
  snapshot: SisalSchemaSnapshot,
  dialect: SisalDialectName,
): readonly string[] {
  return (snapshot.schemaObjects ?? [])
    .filter((object) =>
      (object.dialect === undefined || object.dialect === dialect) &&
      object.down !== undefined
    )
    .map((object) => object.down as string)
    .reverse();
}

/** Returns validation issues for a schema snapshot without mutating it. */
export function validateSchemaSnapshot(
  snapshot: SisalSchemaSnapshot,
): SisalSchemaIssue[] {
  const issues: SisalSchemaIssue[] = [];

  if (snapshot.version !== SCHEMA_SNAPSHOT_VERSION) {
    issues.push(issue(
      "SCHEMA_INVALID_VERSION",
      "version",
      `Schema snapshot version must be ${SCHEMA_SNAPSHOT_VERSION}`,
    ));
  }

  if (snapshot.dialect !== undefined && !DIALECTS.has(snapshot.dialect)) {
    issues.push(issue(
      "SCHEMA_INVALID_DIALECT",
      "dialect",
      "Schema snapshot dialect is not supported",
    ));
  }

  if (!Array.isArray(snapshot.tables)) {
    issues.push(issue(
      "SCHEMA_INVALID_TABLE",
      "tables",
      "Schema snapshot tables must be an array",
    ));
    return issues;
  }

  const tableKeys = new Set<string>();
  const tablesByKey = new Map<string, SisalTableSnapshot>();

  for (
    let tableIndex = 0;
    tableIndex < snapshot.tables.length;
    tableIndex += 1
  ) {
    const table = snapshot.tables[tableIndex];
    const tablePath = `tables[${tableIndex}]`;

    if (!isNonEmptyString(table.name)) {
      issues.push(issue(
        "SCHEMA_INVALID_TABLE",
        `${tablePath}.name`,
        "Table name must be non-empty",
      ));
      continue;
    }

    const tableKey = tableSnapshotKey(table);

    if (tableKeys.has(tableKey)) {
      issues.push(issue(
        "SCHEMA_DUPLICATE_TABLE",
        `${tablePath}.name`,
        "Table names must be unique within schema/name",
      ));
    }

    tableKeys.add(tableKey);
    tablesByKey.set(tableKey, table);
    validateTable(table, tablePath, issues);
  }

  for (
    let tableIndex = 0;
    tableIndex < snapshot.tables.length;
    tableIndex += 1
  ) {
    validateForeignKeyTargets(
      snapshot.tables[tableIndex],
      `tables[${tableIndex}]`,
      tablesByKey,
      issues,
    );
  }

  return issues;
}

/** Throws when a schema snapshot is invalid. */
export function assertValidSchemaSnapshot(
  snapshot: SisalSchemaSnapshot,
): void {
  const issues = validateSchemaSnapshot(snapshot);

  if (issues.length > 0) {
    const error = new Error(
      `Invalid Sisal schema snapshot: ${
        issues.map((entry) => `${entry.path}: ${entry.message}`).join("; ")
      }`,
    );
    (error as Error & { issues?: SisalSchemaIssue[] }).issues = issues;
    throw error;
  }
}

/**
 * Returns a deterministic clone of a schema snapshot.
 *
 * Tables are sorted by `schema.name`; columns preserve declaration order because
 * order is meaningful to schema authors and later diffs.
 */
export function normalizeSchemaSnapshot(
  snapshot: SisalSchemaSnapshot,
): SisalSchemaSnapshot {
  return {
    version: snapshot.version,
    ...(snapshot.dialect === undefined ? {} : { dialect: snapshot.dialect }),
    ...(snapshot.dialectVariant === undefined
      ? {}
      : { dialectVariant: snapshot.dialectVariant }),
    ...(snapshot.dialectVersion === undefined
      ? {}
      : { dialectVersion: snapshot.dialectVersion }),
    tables: [...(snapshot.tables ?? [])]
      .map(normalizeTableSnapshot)
      .sort(compareTables),
    // Schema objects keep declared order — they are dependency-ordered (a
    // trigger after its function), so they are not sorted like tables.
    ...(snapshot.schemaObjects === undefined ||
        snapshot.schemaObjects.length === 0
      ? {}
      : { schemaObjects: snapshot.schemaObjects.map(normalizeSchemaObject) }),
    ...(snapshot.metadata === undefined
      ? {}
      : { metadata: cloneRecord(snapshot.metadata) }),
  };
}

/**
 * Serializes a snapshot to canonical JSON.
 *
 * The snapshot is normalized first, so two snapshots that differ only in
 * table/index/constraint ordering serialize to identical strings. Use this for
 * storage, migration journals, and checksums.
 */
export function serializeSchemaSnapshot(
  snapshot: SisalSchemaSnapshot,
): string {
  return JSON.stringify(normalizeSchemaSnapshot(snapshot));
}

/**
 * Parses canonical JSON produced by {@link serializeSchemaSnapshot}, then
 * normalizes and validates it. Throws when the JSON is malformed or the
 * resulting snapshot is invalid, so a successful call always returns a valid,
 * normalized snapshot.
 */
export function deserializeSchemaSnapshot(
  text: string,
): SisalSchemaSnapshot {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error("Invalid Sisal schema snapshot JSON", { cause });
  }

  return defineSchemaSnapshot(parsed as SisalSchemaSnapshot);
}

/** Returns true when two snapshots are structurally equal after normalization. */
export function equalSchemaSnapshots(
  a: SisalSchemaSnapshot,
  b: SisalSchemaSnapshot,
): boolean {
  return serializeSchemaSnapshot(a) === serializeSchemaSnapshot(b);
}

/** A column present in both tables whose definition changed. */
export interface SisalColumnDiff {
  readonly name: string;
  readonly from: SisalColumnSnapshot;
  readonly to: SisalColumnSnapshot;
}

/** Column-level changes between two versions of one table. */
export interface SisalTableColumnsDiff {
  readonly added: readonly SisalColumnSnapshot[];
  readonly removed: readonly SisalColumnSnapshot[];
  readonly changed: readonly SisalColumnDiff[];
}

/** A table present in both snapshots whose definition changed. */
export interface SisalTableDiff {
  readonly name: string;
  readonly schema?: string;
  readonly from: SisalTableSnapshot;
  readonly to: SisalTableSnapshot;
  readonly columns: SisalTableColumnsDiff;
}

/** Structural difference between two schema snapshots (`from` → `to`). */
export interface SisalSchemaSnapshotDiff {
  readonly addedTables: readonly SisalTableSnapshot[];
  readonly removedTables: readonly SisalTableSnapshot[];
  readonly changedTables: readonly SisalTableDiff[];
}

/**
 * Computes the structural difference from one snapshot to another.
 *
 * Both snapshots are normalized first, so ordering differences are ignored.
 * Tables are matched by `schema.name`, columns by `name`. A column is `changed`
 * when its normalized definition differs; a table is in `changedTables` when its
 * normalized form differs (covering columns and constraints). This is the
 * dependency-free primitive `@sisal/migrate` builds generated migrations on,
 * without `orm` and `migrate` importing each other.
 */
export function diffSchemaSnapshots(
  from: SisalSchemaSnapshot,
  to: SisalSchemaSnapshot,
): SisalSchemaSnapshotDiff {
  const fromTables = indexTables(normalizeSchemaSnapshot(from));
  const toTables = indexTables(normalizeSchemaSnapshot(to));

  const addedTables: SisalTableSnapshot[] = [];
  const removedTables: SisalTableSnapshot[] = [];
  const changedTables: SisalTableDiff[] = [];

  for (const [key, table] of toTables) {
    if (!fromTables.has(key)) {
      addedTables.push(table);
    }
  }

  for (const [key, fromTable] of fromTables) {
    const toTable = toTables.get(key);

    if (toTable === undefined) {
      removedTables.push(fromTable);
      continue;
    }

    if (JSON.stringify(fromTable) === JSON.stringify(toTable)) {
      continue;
    }

    changedTables.push({
      name: fromTable.name,
      ...(fromTable.schema === undefined ? {} : { schema: fromTable.schema }),
      from: fromTable,
      to: toTable,
      columns: diffColumns(fromTable.columns, toTable.columns),
    });
  }

  return { addedTables, removedTables, changedTables };
}

/** Returns true when a snapshot diff contains no table or column changes. */
export function isEmptySchemaSnapshotDiff(
  diff: SisalSchemaSnapshotDiff,
): boolean {
  return diff.addedTables.length === 0 &&
    diff.removedTables.length === 0 &&
    diff.changedTables.length === 0;
}

function indexTables(
  snapshot: SisalSchemaSnapshot,
): Map<string, SisalTableSnapshot> {
  const tables = new Map<string, SisalTableSnapshot>();

  for (const table of snapshot.tables) {
    tables.set(tableSnapshotKey(table), table);
  }

  return tables;
}

function diffColumns(
  fromColumns: readonly SisalColumnSnapshot[],
  toColumns: readonly SisalColumnSnapshot[],
): SisalTableColumnsDiff {
  const fromByName = new Map(
    fromColumns.map((column) => [column.name, column] as const),
  );
  const toByName = new Map(
    toColumns.map((column) => [column.name, column] as const),
  );

  const added: SisalColumnSnapshot[] = [];
  const removed: SisalColumnSnapshot[] = [];
  const changed: SisalColumnDiff[] = [];

  for (const column of toColumns) {
    if (!fromByName.has(column.name)) {
      added.push(column);
    }
  }

  for (const column of fromColumns) {
    const next = toByName.get(column.name);

    if (next === undefined) {
      removed.push(column);
      continue;
    }

    if (JSON.stringify(column) !== JSON.stringify(next)) {
      changed.push({ name: column.name, from: column, to: next });
    }
  }

  return { added, removed, changed };
}

function normalizeTableSnapshot(
  table: SisalTableSnapshot,
): SisalTableSnapshot {
  return {
    name: table.name,
    ...(table.schema === undefined ? {} : { schema: table.schema }),
    columns: [...(table.columns ?? [])].map(normalizeColumnSnapshot),
    ...(table.primaryKey === undefined
      ? {}
      : { primaryKey: normalizePrimaryKey(table.primaryKey) }),
    indexes: [...(table.indexes ?? [])].map(normalizeIndex).sort(compareNamed),
    uniqueConstraints: [...(table.uniqueConstraints ?? [])]
      .map(normalizeUniqueConstraint)
      .sort(compareNamed),
    foreignKeys: [...(table.foreignKeys ?? [])]
      .map(normalizeForeignKey)
      .sort(compareNamed),
    checks: [...(table.checks ?? [])].map(normalizeCheck).sort(compareNamed),
    ...(table.metadata === undefined
      ? {}
      : { metadata: cloneRecord(table.metadata) }),
  };
}

function normalizeColumnSnapshot(
  column: SisalColumnSnapshot,
): SisalColumnSnapshot {
  return {
    name: column.name,
    type: {
      kind: column.type.kind,
      ...(column.type.length === undefined
        ? {}
        : { length: column.type.length }),
      ...(column.type.precision === undefined
        ? {}
        : { precision: column.type.precision }),
      ...(column.type.scale === undefined ? {} : { scale: column.type.scale }),
      ...(column.type.array === undefined ? {} : { array: column.type.array }),
      ...(column.type.dialectType === undefined
        ? {}
        : { dialectType: column.type.dialectType }),
    },
    ...(column.nullable === undefined ? {} : { nullable: column.nullable }),
    ...(column.default === undefined
      ? {}
      : { default: normalizeColumnDefault(column.default) }),
    ...(column.generated === undefined ? {} : { generated: column.generated }),
    ...(column.references === undefined ? {} : {
      references: {
        table: column.references.table,
        ...(column.references.schema === undefined
          ? {}
          : { schema: column.references.schema }),
        column: column.references.column,
        ...(column.references.onDelete === undefined
          ? {}
          : { onDelete: column.references.onDelete }),
        ...(column.references.onUpdate === undefined
          ? {}
          : { onUpdate: column.references.onUpdate }),
      },
    }),
    ...(column.metadata === undefined
      ? {}
      : { metadata: cloneRecord(column.metadata) }),
  };
}

function normalizeColumnDefault(
  value: SisalColumnDefault,
): SisalColumnDefault {
  return value.kind === "literal"
    ? { kind: "literal", value: value.value }
    : { kind: "expression", sql: value.sql };
}

function normalizePrimaryKey(
  value: SisalPrimaryKeySnapshot,
): SisalPrimaryKeySnapshot {
  return {
    ...(value.name === undefined ? {} : { name: value.name }),
    columns: [...value.columns],
    ...(value.metadata === undefined
      ? {}
      : { metadata: cloneRecord(value.metadata) }),
  };
}

function normalizeIndex(value: SisalIndexSnapshot): SisalIndexSnapshot {
  return {
    ...(value.name === undefined ? {} : { name: value.name }),
    columns: value.columns.map(normalizeIndexColumn),
    ...(value.unique === undefined ? {} : { unique: value.unique }),
    ...(value.where === undefined ? {} : { where: value.where }),
    ...(value.metadata === undefined
      ? {}
      : { metadata: cloneRecord(value.metadata) }),
  };
}

function normalizeIndexColumn(
  value: SisalIndexColumnSnapshot,
): SisalIndexColumnSnapshot {
  return {
    value: value.value,
    ...(value.direction === undefined ? {} : { direction: value.direction }),
    ...(value.expression === undefined ? {} : { expression: value.expression }),
  };
}

function normalizeUniqueConstraint(
  value: SisalUniqueConstraintSnapshot,
): SisalUniqueConstraintSnapshot {
  return {
    ...(value.name === undefined ? {} : { name: value.name }),
    columns: [...value.columns],
    ...(value.metadata === undefined
      ? {}
      : { metadata: cloneRecord(value.metadata) }),
  };
}

function normalizeForeignKey(
  value: SisalForeignKeySnapshot,
): SisalForeignKeySnapshot {
  return {
    ...(value.name === undefined ? {} : { name: value.name }),
    columns: [...value.columns],
    references: {
      table: value.references.table,
      ...(value.references.schema === undefined
        ? {}
        : { schema: value.references.schema }),
      columns: [...value.references.columns],
    },
    ...(value.onDelete === undefined ? {} : { onDelete: value.onDelete }),
    ...(value.onUpdate === undefined ? {} : { onUpdate: value.onUpdate }),
    ...(value.metadata === undefined
      ? {}
      : { metadata: cloneRecord(value.metadata) }),
  };
}

function normalizeCheck(
  value: SisalCheckConstraintSnapshot,
): SisalCheckConstraintSnapshot {
  return {
    ...(value.name === undefined ? {} : { name: value.name }),
    expression: value.expression,
    ...(value.metadata === undefined
      ? {}
      : { metadata: cloneRecord(value.metadata) }),
  };
}

function validateTable(
  table: SisalTableSnapshot,
  path: string,
  issues: SisalSchemaIssue[],
): void {
  if (!Array.isArray(table.columns)) {
    issues.push(issue(
      "SCHEMA_INVALID_COLUMN",
      `${path}.columns`,
      "Table columns must be an array",
    ));
    return;
  }

  const columns = new Set<string>();

  for (
    let columnIndex = 0;
    columnIndex < table.columns.length;
    columnIndex += 1
  ) {
    const column = table.columns[columnIndex];
    const columnPath = `${path}.columns[${columnIndex}]`;

    if (!isNonEmptyString(column.name)) {
      issues.push(issue(
        "SCHEMA_INVALID_COLUMN",
        `${columnPath}.name`,
        "Column name must be non-empty",
      ));
      continue;
    }

    if (columns.has(column.name)) {
      issues.push(issue(
        "SCHEMA_DUPLICATE_COLUMN",
        `${columnPath}.name`,
        "Column names must be unique per table",
      ));
    }

    columns.add(column.name);

    if (!isNonEmptyString(column.type?.kind)) {
      issues.push(issue(
        "SCHEMA_INVALID_COLUMN",
        `${columnPath}.type.kind`,
        "Column type kind must be non-empty",
      ));
    }
  }

  validateColumnList(
    table.primaryKey?.columns,
    columns,
    `${path}.primaryKey`,
    issues,
  );
  validateIndexes(table.indexes, columns, `${path}.indexes`, issues);
  validateNamedColumnLists(
    table.uniqueConstraints,
    columns,
    `${path}.uniqueConstraints`,
    issues,
  );

  for (let index = 0; index < (table.foreignKeys ?? []).length; index += 1) {
    validateColumnList(
      table.foreignKeys?.[index].columns,
      columns,
      `${path}.foreignKeys[${index}]`,
      issues,
    );
  }
}

function validateForeignKeyTargets(
  table: SisalTableSnapshot,
  path: string,
  tablesByKey: Map<string, SisalTableSnapshot>,
  issues: SisalSchemaIssue[],
): void {
  const checkTarget = (
    targetTable: string,
    targetSchema: string | undefined,
    targetColumn: string,
    targetPath: string,
  ): void => {
    const target = tablesByKey.get(tableSnapshotKey({
      name: targetTable,
      ...(targetSchema === undefined ? {} : { schema: targetSchema }),
    }));

    if (target === undefined) {
      return;
    }

    if (!target.columns.some((column) => column.name === targetColumn)) {
      issues.push(issue(
        "SCHEMA_UNKNOWN_TARGET",
        targetPath,
        "Foreign key target column does not exist",
      ));
    }
  };

  for (let index = 0; index < table.columns.length; index += 1) {
    const reference = table.columns[index].references;

    if (reference !== undefined) {
      checkTarget(
        reference.table,
        reference.schema,
        reference.column,
        `${path}.columns[${index}].references.column`,
      );
    }
  }

  for (let index = 0; index < (table.foreignKeys ?? []).length; index += 1) {
    const foreignKey = table.foreignKeys![index];
    const target = tablesByKey.get(tableSnapshotKey({
      name: foreignKey.references.table,
      ...(foreignKey.references.schema === undefined
        ? {}
        : { schema: foreignKey.references.schema }),
    }));

    if (target === undefined) {
      continue;
    }

    const targetColumns = new Set(target.columns.map((column) => column.name));

    for (
      let columnIndex = 0;
      columnIndex < foreignKey.references.columns.length;
      columnIndex += 1
    ) {
      const column = foreignKey.references.columns[columnIndex];

      if (!targetColumns.has(column)) {
        issues.push(issue(
          "SCHEMA_UNKNOWN_TARGET",
          `${path}.foreignKeys[${index}].references.columns[${columnIndex}]`,
          "Foreign key target column does not exist",
        ));
      }
    }
  }
}

function validateNamedColumnLists(
  values: readonly SisalUniqueConstraintSnapshot[] | undefined,
  columns: Set<string>,
  path: string,
  issues: SisalSchemaIssue[],
): void {
  for (let index = 0; index < (values ?? []).length; index += 1) {
    validateColumnList(
      values?.[index].columns,
      columns,
      `${path}[${index}]`,
      issues,
    );
  }
}

// Indexes carry structured keys (`{ value, direction?, expression? }`); only a
// plain-column key references a real column, while an expression key holds raw
// SQL and is not checked against the table's columns.
function validateIndexes(
  values: readonly SisalIndexSnapshot[] | undefined,
  columns: Set<string>,
  path: string,
  issues: SisalSchemaIssue[],
): void {
  for (let index = 0; index < (values ?? []).length; index += 1) {
    const keys = values?.[index].columns;
    const indexPath = `${path}[${index}]`;
    if (keys === undefined || !Array.isArray(keys) || keys.length === 0) {
      issues.push(issue(
        "SCHEMA_INVALID_CONSTRAINT",
        `${indexPath}.columns`,
        "Constraint columns must be a non-empty array",
      ));
      continue;
    }
    for (let key = 0; key < keys.length; key += 1) {
      const column = keys[key];
      if (column.expression !== true && !columns.has(column.value)) {
        issues.push(issue(
          "SCHEMA_UNKNOWN_COLUMN",
          `${indexPath}.columns[${key}]`,
          "Constraint column does not exist",
        ));
      }
    }
  }
}

function validateColumnList(
  names: readonly string[] | undefined,
  columns: Set<string>,
  path: string,
  issues: SisalSchemaIssue[],
): void {
  if (names === undefined) {
    return;
  }

  if (!Array.isArray(names) || names.length === 0) {
    issues.push(issue(
      "SCHEMA_INVALID_CONSTRAINT",
      `${path}.columns`,
      "Constraint columns must be a non-empty array",
    ));
    return;
  }

  for (let index = 0; index < names.length; index += 1) {
    if (!columns.has(names[index])) {
      issues.push(issue(
        "SCHEMA_UNKNOWN_COLUMN",
        `${path}.columns[${index}]`,
        "Constraint column does not exist",
      ));
    }
  }
}

function issue(
  code: SisalSchemaIssueCode,
  path: string,
  message: string,
): SisalSchemaIssue {
  return { code, path, message };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function tableSnapshotKey(
  table: Pick<SisalTableSnapshot, "name" | "schema">,
): string {
  return `${table.schema ?? ""}.${table.name}`;
}

function compareTables(
  left: SisalTableSnapshot,
  right: SisalTableSnapshot,
): number {
  return tableSnapshotKey(left).localeCompare(tableSnapshotKey(right));
}

function compareNamed(
  left: {
    readonly name?: string;
    readonly columns?: readonly (string | SisalIndexColumnSnapshot)[];
  },
  right: {
    readonly name?: string;
    readonly columns?: readonly (string | SisalIndexColumnSnapshot)[];
  },
): number {
  const key = (value: typeof left): string =>
    value.name ??
      (value.columns ?? [])
        .map((column) => typeof column === "string" ? column : column.value)
        .join(",");
  return key(left).localeCompare(key(right));
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return { ...value };
}
