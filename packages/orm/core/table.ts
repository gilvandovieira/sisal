/**
 * Table definitions, table-level constraints, type inference, introspection,
 * and serializable schema-snapshot conversion.
 *
 * Part of the `@sisal/orm` core; re-exported through `./mod.ts`.
 */

import {
  defineSchemaSnapshot,
  type SisalCheckConstraintSnapshot,
  type SisalColumnDefault,
  type SisalDialectName,
  type SisalIndexSnapshot,
  type SisalSchemaSnapshot,
  type SisalUniqueConstraintSnapshot,
} from "../schema.ts";
import {
  cloneColumnDefinition,
  type ColumnBuilder,
  type ColumnDefinition,
  isColumnBuilder,
} from "./columns.ts";
import { OrmError } from "./errors.ts";
import {
  type ColumnName,
  isColumn,
  isRecord,
  isSql,
  normalizeColumnName,
  normalizeTableName,
  renderSql,
  type Sql,
  type TableName,
} from "./sql.ts";

/**
 * A column-naming strategy: how a JavaScript property key maps to the physical
 * SQL column name when a column does not declare an explicit `.named(...)`.
 *
 * - `"snake_case"` — `hotScore` → `hot_score` (the global default).
 * - `"camelCase"` — `hot_score` → `hotScore`.
 * - `"preserve"` — the property key is used verbatim (pre-0.4.0 behavior).
 * - a function — a custom `(propertyName) => physicalName` mapper.
 */
export type ColumnNamingStrategy =
  | "snake_case"
  | "camelCase"
  | "preserve"
  | ((propertyName: string) => string);

let defaultColumnNaming: ColumnNamingStrategy = "snake_case";

/**
 * Returns the global default column-naming strategy applied by {@link defineTable}
 * when a table does not pass its own `naming` option. Defaults to `"snake_case"`.
 */
export function getDefaultColumnNaming(): ColumnNamingStrategy {
  return defaultColumnNaming;
}

/**
 * Sets the global default column-naming strategy for **future** {@link defineTable}
 * calls. Tables already defined keep the name they were built with, so call this
 * before defining your tables (e.g. at the top of your schema module). Pass
 * `"preserve"` to restore the pre-0.4.0 verbatim behavior globally.
 */
export function setDefaultColumnNaming(strategy: ColumnNamingStrategy): void {
  assertNamingStrategy(strategy);
  defaultColumnNaming = strategy;
}

function assertNamingStrategy(
  strategy: unknown,
): asserts strategy is ColumnNamingStrategy {
  if (
    typeof strategy === "function" || strategy === "snake_case" ||
    strategy === "camelCase" || strategy === "preserve"
  ) {
    return;
  }
  throw new OrmError("Invalid column naming strategy", {
    code: "ORM_INVALID_TABLE",
    details: { strategy },
  });
}

/** Resolves a property key to its physical column name under a strategy. */
function applyColumnNaming(
  propertyName: string,
  strategy: ColumnNamingStrategy,
): string {
  if (typeof strategy === "function") {
    return strategy(propertyName);
  }
  switch (strategy) {
    case "snake_case":
      return toSnakeCase(propertyName);
    case "camelCase":
      return toCamelCase(propertyName);
    case "preserve":
      return propertyName;
  }
}

// Idempotent on already-snake_case input: `post_id` → `post_id`, `id` → `id`.
function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

function toCamelCase(name: string): string {
  return name.replace(
    /_+([a-zA-Z0-9])/g,
    (_match, char: string) => char.toUpperCase(),
  );
}

/** Column builder map passed to {@link defineTable}. */
export type TableColumns = Record<
  string,
  ColumnBuilder<unknown, boolean, boolean>
>;

/** Materialized column metadata inferred from a {@link ColumnBuilder}. */
export type ColumnDefinitionFromBuilder<TBuilder> = TBuilder extends
  ColumnBuilder<infer TValue, infer TOptional, infer THasDefault>
  ? Omit<ColumnDefinition<TValue>, "name"> & {
    readonly name: ColumnName;
    readonly optionalInsert: TOptional;
    readonly defaultInsert: THasDefault;
    readonly insertOptional: TOptional extends true ? true
      : THasDefault extends true ? true
      : false;
  }
  : never;

/** Table schema definition returned by defineTable. */
export interface TableDefinition<
  TColumns extends TableColumns = TableColumns,
> {
  readonly kind: "table";
  readonly name: TableName;
  readonly schema?: string;
  readonly columns: {
    readonly [K in keyof TColumns]: ColumnDefinitionFromBuilder<TColumns[K]> & {
      readonly propertyName: K & string;
      readonly tableName: string;
    };
  };
  /** Table-level constraints/indexes from `defineTable`'s extras callback. */
  readonly extras?: readonly TableConstraint[];
}

/** Any Sisal table definition, regardless of its column map. */
// deno-lint-ignore no-explicit-any -- This alias intentionally erases table column specifics.
export type AnyTableDefinition = TableDefinition<any>;

/**
 * A table-level constraint or index produced by the {@link defineTable} extras
 * callback — `index`/`uniqueIndex`, `primaryKey`, `unique`, or `check`.
 */
export type TableConstraint =
  | {
    readonly kind: "index";
    readonly name?: string;
    readonly columns: readonly string[];
    readonly unique: boolean;
  }
  | { readonly kind: "primaryKey"; readonly columns: readonly string[] }
  | {
    readonly kind: "unique";
    readonly name?: string;
    readonly columns: readonly string[];
  }
  | { readonly kind: "check"; readonly name: string; readonly expression: Sql };

/** Fluent builder returned by {@link index} / {@link uniqueIndex}. */
export interface IndexConstraintBuilder {
  /** Sets the indexed columns (column references or names). */
  on(...columns: readonly unknown[]): TableConstraint;
}

/** Fluent builder returned by {@link unique}. */
export interface UniqueConstraintBuilder {
  /** Sets the constrained columns (column references or names). */
  on(...columns: readonly unknown[]): TableConstraint;
}

function constraintColumnNames(columns: readonly unknown[]): string[] {
  if (columns.length === 0) {
    throw new OrmError("A constraint requires at least one column", {
      code: "ORM_INVALID_QUERY",
    });
  }
  return columns.map((column) => {
    if (typeof column === "string") {
      return normalizeColumnName(column);
    }
    if (isColumn(column)) {
      return column.name;
    }
    throw new OrmError("Constraint column must be a column or column name", {
      code: "ORM_INVALID_COLUMN",
    });
  });
}

/** A table index (`CREATE INDEX`); complete it with `.on(...columns)`. */
export function index(name?: string): IndexConstraintBuilder {
  return {
    on: (...columns) => ({
      kind: "index",
      ...(name === undefined ? {} : { name }),
      columns: constraintColumnNames(columns),
      unique: false,
    }),
  };
}

/** A unique table index (`CREATE UNIQUE INDEX`); complete with `.on(...)`. */
export function uniqueIndex(name?: string): IndexConstraintBuilder {
  return {
    on: (...columns) => ({
      kind: "index",
      ...(name === undefined ? {} : { name }),
      columns: constraintColumnNames(columns),
      unique: true,
    }),
  };
}

/** A composite/table-level primary key over the given columns. */
export function primaryKey(
  config: { readonly columns: readonly unknown[] },
): TableConstraint {
  return { kind: "primaryKey", columns: constraintColumnNames(config.columns) };
}

/** A named/composite `UNIQUE` constraint; complete it with `.on(...columns)`. */
export function unique(name?: string): UniqueConstraintBuilder {
  return {
    on: (...columns) => ({
      kind: "unique",
      ...(name === undefined ? {} : { name }),
      columns: constraintColumnNames(columns),
    }),
  };
}

/** A named `CHECK` constraint from a `sql` expression. */
export function check(name: string, expression: Sql): TableConstraint {
  if (!isSql(expression)) {
    throw new OrmError("check() expects a sql`...` expression", {
      code: "ORM_INVALID_QUERY",
    });
  }
  return { kind: "check", name, expression };
}

/** Extracts the selected (read) value type a column builder produces. */
type ColumnValueFromBuilder<TBuilder> = TBuilder extends
  ColumnBuilder<infer TValue, boolean, boolean> ? TValue : never;

/** True when a column may be omitted on insert — it is `.optional()` or has a default. */
type InsertOptionalFromBuilder<TBuilder> = TBuilder extends
  ColumnBuilder<unknown, infer TOptional, infer THasDefault>
  ? TOptional extends true ? true
  : THasDefault extends true ? true
  : false
  : false;

/** The column keys that must be provided when inserting a row. */
type RequiredInsertKeys<TColumns extends TableColumns> = {
  [K in keyof TColumns]: InsertOptionalFromBuilder<TColumns[K]> extends true
    ? never
    : K;
}[keyof TColumns];

/** The column keys that may be omitted when inserting a row. */
type OptionalInsertKeys<TColumns extends TableColumns> = {
  [K in keyof TColumns]: InsertOptionalFromBuilder<TColumns[K]> extends true ? K
    : never;
}[keyof TColumns];

/** Infers the row shape returned when selecting from a table. */
export type InferSelect<TTable> = TTable extends TableDefinition<infer TColumns>
  ? {
    readonly [K in keyof TColumns]: ColumnValueFromBuilder<TColumns[K]>;
  }
  : never;

/** Infers the accepted insert shape for a table, honoring defaults and optional fields. */
export type InferInsert<TTable> = TTable extends TableDefinition<infer TColumns>
  ?
    & {
      readonly [K in RequiredInsertKeys<TColumns>]: ColumnValueFromBuilder<
        TColumns[K]
      >;
    }
    & {
      readonly [K in OptionalInsertKeys<TColumns>]?: ColumnValueFromBuilder<
        TColumns[K]
      >;
    }
  : never;

/** Materialized column belonging to a table definition. */
export type TableColumn<TTable extends TableDefinition> =
  TTable["columns"][keyof TTable["columns"]];

/** Options applied when building a schema snapshot from ORM tables. */
export interface CreateSchemaSnapshotOptions {
  readonly dialect?: SisalDialectName;
  readonly metadata?: Record<string, unknown>;
}

/** Input accepted by {@link createSchemaSnapshot}. */
export interface CreateSchemaSnapshotInput extends CreateSchemaSnapshotOptions {
  readonly tables: readonly TableDefinition[] | Record<string, TableDefinition>;
}

/** Options accepted by {@link defineTable}. */
export interface DefineTableOptions {
  /** Optional schema/namespace the table lives in (e.g. `"app"`). */
  readonly schema?: string;
  /**
   * Column-naming strategy for this table. Overrides the global default set via
   * {@link setDefaultColumnNaming}; columns with an explicit `.named(...)` are
   * never transformed.
   */
  readonly naming?: ColumnNamingStrategy;
}

/** Defines a typed table schema. */
export function defineTable<TColumns extends TableColumns>(
  name: TableName,
  tableColumns: TColumns,
  extrasOrOptions?:
    | ((
      columns: TableDefinition<TColumns>["columns"],
    ) => readonly TableConstraint[])
    | DefineTableOptions,
  options: DefineTableOptions = {},
): TableDefinition<TColumns> {
  const extras = typeof extrasOrOptions === "function"
    ? extrasOrOptions
    : undefined;
  const resolvedOptions = typeof extrasOrOptions === "function"
    ? options
    : extrasOrOptions ?? {};
  const tableName = normalizeTableName(name);
  const schema = resolvedOptions.schema === undefined
    ? undefined
    : normalizeTableName(resolvedOptions.schema);
  const naming = resolvedOptions.naming ?? defaultColumnNaming;
  assertNamingStrategy(naming);
  const finalColumns: Record<string, unknown> = {};

  for (const [propertyName, builder] of Object.entries(tableColumns)) {
    if (!isColumnBuilder(builder)) {
      throw new OrmError("Table column must be a ColumnBuilder", {
        code: "ORM_INVALID_COLUMN",
        details: { table: tableName, propertyName },
      });
    }

    const columnName = normalizeColumnName(
      builder.definition.name ?? applyColumnNaming(propertyName, naming),
    );
    const definition = cloneColumnDefinition(builder.definition);

    finalColumns[propertyName] = Object.freeze({
      ...definition,
      name: columnName,
      propertyName,
      tableName,
      optionalInsert: builder.optionalInsert,
      defaultInsert: builder.defaultInsert,
      insertOptional: builder.optionalInsert || builder.defaultInsert,
    });
  }

  const frozenColumns = Object.freeze(
    finalColumns,
  ) as TableDefinition<TColumns>["columns"];
  const constraints = extras === undefined
    ? undefined
    : Object.freeze([...extras(frozenColumns)]);

  return Object.freeze({
    kind: "table",
    name: tableName,
    ...(schema === undefined ? {} : { schema }),
    columns: frozenColumns,
    ...(constraints === undefined ? {} : { extras: constraints }),
  }) as TableDefinition<TColumns>;
}

/** Creates a stable Sisal schema snapshot from ORM table metadata. */
export function createSchemaSnapshot(
  input: CreateSchemaSnapshotInput,
): SisalSchemaSnapshot {
  const tables = Array.isArray(input.tables)
    ? input.tables
    : Object.values(input.tables);

  return defineSchemaSnapshot({
    version: 1,
    ...(input.dialect === undefined ? {} : { dialect: input.dialect }),
    tables: tables.map(tableToSnapshot),
    ...(input.metadata === undefined
      ? {}
      : { metadata: { ...input.metadata } }),
  });
}

/** Returns table columns. */
export function getTableColumns<TTable extends TableDefinition>(
  table: TTable,
): TTable["columns"] {
  assertTable(table);
  return table.columns;
}

/** Returns the normalized table name. */
export function getTableName(table: TableDefinition): TableName {
  assertTable(table);
  return table.name;
}

/** Returns true when a value has the public table definition shape. */
export function isTable(value: unknown): value is TableDefinition {
  return isRecord(value) && value.kind === "table" &&
    typeof value.name === "string" &&
    isRecord(value.columns);
}

function tableToSnapshot(
  table: TableDefinition,
): SisalSchemaSnapshot["tables"][number] {
  assertTable(table);

  const columns = Object.values(table.columns);
  const primaryKeyColumns = columns
    .filter((column) => column.primaryKey)
    .map((column) => column.name);
  const uniqueConstraints = columns
    .filter((column) => column.unique)
    .map((column) => ({ columns: [column.name] }));
  const foreignKeys = columns
    .filter((column) => column.references !== undefined)
    .map((column) => ({
      columns: [column.name],
      references: {
        table: column.references!.table,
        columns: [column.references!.column],
      },
      ...(column.references!.onDelete === undefined
        ? {}
        : { onDelete: column.references!.onDelete }),
      ...(column.references!.onUpdate === undefined
        ? {}
        : { onUpdate: column.references!.onUpdate }),
    }));

  // Table-level constraints/indexes from the defineTable extras callback.
  const indexes: SisalIndexSnapshot[] = [];
  const extraUnique: SisalUniqueConstraintSnapshot[] = [];
  const checks: SisalCheckConstraintSnapshot[] = [];
  let tablePrimaryKey: { readonly columns: readonly string[] } | undefined;
  for (const constraint of table.extras ?? []) {
    switch (constraint.kind) {
      case "index":
        indexes.push({
          ...(constraint.name === undefined ? {} : { name: constraint.name }),
          columns: [...constraint.columns],
          ...(constraint.unique ? { unique: true } : {}),
        });
        break;
      case "primaryKey":
        tablePrimaryKey = { columns: [...constraint.columns] };
        break;
      case "unique":
        extraUnique.push({
          ...(constraint.name === undefined ? {} : { name: constraint.name }),
          columns: [...constraint.columns],
        });
        break;
      case "check":
        checks.push({
          name: constraint.name,
          // CHECK constraints reference the table's own columns by unqualified
          // name (portable across Postgres/SQLite), so strip the table prefix.
          expression: renderSql(constraint.expression, { dialect: "postgres" })
            .text.replaceAll(`"${table.name}".`, ""),
        });
        break;
    }
  }
  const primaryKey = tablePrimaryKey ??
    (primaryKeyColumns.length === 0
      ? undefined
      : { columns: primaryKeyColumns });

  return {
    name: table.name,
    ...(table.schema === undefined ? {} : { schema: table.schema }),
    columns: columns.map((column) => ({
      name: column.name,
      type: {
        kind: column.dataType,
        ...(column.length === undefined ? {} : { length: column.length }),
        ...(column.precision === undefined
          ? {}
          : { precision: column.precision }),
        ...(column.scale === undefined ? {} : { scale: column.scale }),
        ...(column.array === undefined ? {} : { array: column.array }),
        ...(column.dialectType === undefined
          ? {}
          : { dialectType: column.dialectType }),
      },
      nullable: column.nullable,
      ...(column.references === undefined ? {} : {
        references: {
          table: column.references.table,
          column: column.references.column,
        },
      }),
      ...(columnDefaultToSnapshot(column.defaultValue) === undefined
        ? {}
        : { default: columnDefaultToSnapshot(column.defaultValue) }),
      metadata: {
        propertyName: column.propertyName,
        optionalInsert: column.optionalInsert,
        defaultInsert: column.defaultInsert,
        hasDefault: column.hasDefault,
      },
    })),
    ...(primaryKey === undefined ? {} : { primaryKey }),
    uniqueConstraints: [...uniqueConstraints, ...extraUnique],
    foreignKeys,
    indexes,
    checks,
  };
}

function columnDefaultToSnapshot(
  value: unknown,
): SisalColumnDefault | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return { kind: "literal", value };
  }

  return undefined;
}

export function assertTable(value: unknown): asserts value is TableDefinition {
  if (!isTable(value)) {
    throw new OrmError("Expected a table definition", {
      code: "ORM_INVALID_TABLE",
    });
  }
}

export function assertTableColumn(table: TableDefinition, key: string): void {
  if (!Object.hasOwn(table.columns, key)) {
    throw new OrmError("Unknown table column", {
      code: "ORM_INVALID_COLUMN",
      details: { table: table.name, column: key },
    });
  }
}
