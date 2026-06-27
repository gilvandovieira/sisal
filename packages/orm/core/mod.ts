/**
 * Typed SQL builders and ORM driver contracts for `@sisal/orm`.
 *
 * @module
 */

import { SisalError } from "../error.ts";
import type { Logger } from "../logger.ts";
import {
  defineSchemaSnapshot,
  type SisalColumnDefault,
  type SisalDialectName,
  type SisalSchemaSnapshot,
} from "../schema.ts";

/** Error codes emitted by ORM schema, SQL, driver, and transaction helpers. */
export type OrmErrorCode =
  | "ORM_INVALID_TABLE"
  | "ORM_INVALID_COLUMN"
  | "ORM_INVALID_QUERY"
  | "ORM_INVALID_SQL"
  | "ORM_DRIVER_MISSING"
  | "ORM_EXECUTE_FAILED"
  | "ORM_TRANSACTION_FAILED"
  | "ORM_SERIALIZATION_FAILED"
  | "ORM_UNKNOWN_ERROR"
  | (string & Record<never, never>);

/** Normalized table name, optionally including a validated schema path. */
export type TableName = string;

/** Normalized simple column name. */
export type ColumnName = string;

/** Column data types supported by the built-in column builder factory. */
export type ColumnDataType =
  | "text"
  | "varchar"
  | "char"
  | "integer"
  | "smallint"
  | "bigint"
  | "serial"
  | "bigserial"
  | "number"
  | "numeric"
  | "decimal"
  | "real"
  | "double"
  | "boolean"
  | "json"
  | "jsonb"
  | "date"
  | "timestamp"
  | "timestamptz"
  | "uuid";

/** JavaScript runtime value types represented by ORM columns. */
export type ColumnRuntimeType =
  | string
  | number
  | boolean
  | Date
  | null
  | Record<string, unknown>
  | unknown[];

/** Column metadata used by table definitions and future adapters. */
export interface ColumnDefinition<T> {
  readonly name?: ColumnName;
  readonly dataType: ColumnDataType;
  readonly length?: number;
  readonly precision?: number;
  readonly scale?: number;
  readonly array?: boolean;
  readonly nullable: boolean;
  readonly hasDefault: boolean;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  readonly references?: {
    readonly table: string;
    readonly column: string;
  };
  readonly defaultValue?: T | (() => T);
  readonly onUpdate?: () => unknown;
}

/** Immutable column builder used to define table schemas. */
export interface ColumnBuilder<
  T,
  TOptional extends boolean = false,
  THasDefault extends boolean = false,
> {
  readonly definition: ColumnDefinition<T>;
  readonly optionalInsert: TOptional;
  readonly defaultInsert: THasDefault;

  named(name: string): ColumnBuilder<T, TOptional, THasDefault>;
  notNull(): ColumnBuilder<NonNullable<T>, TOptional, THasDefault>;
  nullable(): ColumnBuilder<T | null, TOptional, THasDefault>;
  optional(): ColumnBuilder<T | undefined, true, THasDefault>;
  default(value: T | (() => T)): ColumnBuilder<T, TOptional, true>;
  /** Adds the column to the primary key. Implies `.notNull()`. */
  primaryKey(): ColumnBuilder<NonNullable<T>, TOptional, THasDefault>;
  unique(): ColumnBuilder<T, TOptional, THasDefault>;
  references(
    table: string,
    column: string,
  ): ColumnBuilder<T, TOptional, THasDefault>;
  /** Makes the column an array of its element type (Postgres `type[]`). */
  array(): ColumnBuilder<ColumnArray<T>, TOptional, THasDefault>;
  /** Runs `fn` to produce a value applied on every `UPDATE` of the row. */
  $onUpdate(fn: () => NonNullable<T>): ColumnBuilder<T, TOptional, THasDefault>;
}

/** Array element/column type produced by {@link ColumnBuilder.array}. */
export type ColumnArray<T> = null extends T ? Array<NonNullable<T>> | null
  : Array<NonNullable<T>>;

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
      readonly propertyName: string;
      readonly tableName: string;
    };
  };
}

/** Any Sisal table definition, regardless of its column map. */
export type AnyTableDefinition = TableDefinition<any>;

type ColumnValueFromBuilder<TBuilder> = TBuilder extends
  ColumnBuilder<infer TValue, boolean, boolean> ? TValue : never;

type InsertOptionalFromBuilder<TBuilder> = TBuilder extends
  ColumnBuilder<unknown, infer TOptional, infer THasDefault>
  ? TOptional extends true ? true
  : THasDefault extends true ? true
  : false
  : false;

type RequiredInsertKeys<TColumns extends TableColumns> = {
  [K in keyof TColumns]: InsertOptionalFromBuilder<TColumns[K]> extends true
    ? never
    : K;
}[keyof TColumns];

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

/** SQL dialect names supported by SQL rendering helpers. */
export type SqlDialect = "postgres" | "sqlite" | "mysql" | "generic";

/** Parameter value shape accepted by rendered SQL queries. */
export type SqlParameter =
  | string
  | number
  | boolean
  | null
  | Date
  | Uint8Array
  | Record<string, unknown>
  | unknown[];

/** Driver-ready SQL text and parameter array. */
export interface SqlQuery {
  readonly text: string;
  readonly params: readonly SqlParameter[];
}

/** Any SQL input accepted by database execution methods. */
export type SqlInput = Sql | SqlQuery | string;

/** SQL fragment made from safe chunks and separate parameters. */
export interface Sql {
  readonly kind: "sql";
  readonly chunks: readonly SqlChunk[];
}

/** Internal chunk representation used by parameterized SQL fragments. */
export type SqlChunk =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "param"; readonly value: SqlParameter }
  | { readonly kind: "raw"; readonly value: string }
  | { readonly kind: "identifier"; readonly value: string }
  | { readonly kind: "sql"; readonly value: Sql };

/** Boolean SQL condition wrapper used by query builders. */
export interface Condition {
  readonly kind: "condition";
  readonly sql: Sql;
}

/** Result returned by ORM drivers and database execution methods. */
export interface OrmQueryResult<T = unknown> {
  readonly rows: T[];
  readonly rowCount?: number;
}

/** Async-first driver contract for future database adapters. */
export interface OrmDriver {
  query<T = unknown>(
    query: SqlQuery,
  ): Promise<OrmQueryResult<T>>;

  execute(
    query: SqlQuery,
  ): Promise<OrmQueryResult>;

  transaction?<T>(
    fn: (tx: OrmTransaction) => Promise<T>,
  ): Promise<T>;

  close?(): Promise<void>;
}

/** Driver transaction facade exposed to transaction callbacks. */
export interface OrmTransaction {
  query<T = unknown>(query: SqlQuery): Promise<OrmQueryResult<T>>;
  execute(query: SqlQuery): Promise<OrmQueryResult>;
}

/** Schema map used to expose `db.query.<table>` relational helpers. */
export type DatabaseSchema = Record<string, AnyTableDefinition>;

/** A raw SQL query executor. */
export interface RawQueryExecutor {
  <T = unknown>(
    query: SqlInput,
    params?: readonly SqlParameter[],
  ): Promise<OrmQueryResult<T>>;
}

/** Relational metadata list accepted by {@link createDatabase}. */
export type RelationsList = readonly TableRelations[];

/** Callable raw-query function plus schema keyed relational query helpers. */
export type DatabaseQuery<
  TSchema extends DatabaseSchema = Record<never, AnyTableDefinition>,
  TRelations extends RelationsList = readonly [],
> =
  & RawQueryExecutor
  & {
    readonly [K in keyof TSchema]: RelationalTableQuery<
      TSchema[K],
      TRelations
    >;
  };

/** Database facade used by query builders and manual SQL execution. */
export interface Database<
  TSchema extends DatabaseSchema = Record<never, AnyTableDefinition>,
  TRelations extends RelationsList = readonly [],
> {
  readonly dialect: SqlDialect;
  readonly query: DatabaseQuery<TSchema, TRelations>;

  execute<T = unknown>(
    query: SqlInput,
    params?: readonly SqlParameter[],
  ): Promise<OrmQueryResult<T>>;

  select(): SelectBuilder<unknown, unknown>;
  select<TProjection extends SelectProjection>(
    projection: TProjection,
  ): SelectBuilder<unknown, InferProjection<TProjection>>;

  insert<TTable extends TableDefinition>(
    table: TTable,
  ): InsertBuilder<TTable>;

  update<TTable extends TableDefinition>(
    table: TTable,
  ): UpdateBuilder<TTable>;

  delete<TTable extends TableDefinition>(
    table: TTable,
  ): DeleteBuilder<TTable>;

  transaction<T>(
    fn: (tx: Database<TSchema, TRelations>) => Promise<T>,
  ): Promise<T>;

  close(): Promise<void>;
}

/** Options for creating a {@link Database}. */
export interface DatabaseOptions<
  TSchema extends DatabaseSchema = Record<never, AnyTableDefinition>,
  TRelations extends RelationsList = readonly [],
> {
  readonly driver?: OrmDriver;
  readonly dialect?: SqlDialect;
  readonly logger?: Logger;
  /** Optional schema map that enables `db.query.<schemaKey>`. */
  readonly schema?: TSchema;
  /** Relation definitions created with {@link relations}. */
  readonly relations?: TRelations;
}

/**
 * A typed SQL expression (e.g. an aggregate like {@link count}) usable as a
 * value in a select projection. The phantom type parameter drives the inferred
 * result type for that projected key.
 */
export interface SqlExpression<T = unknown> extends Sql {
  readonly __exprType?: T;
}

/** A column reference usable in a select projection. */
export interface SelectColumnRef {
  readonly name: ColumnName;
  readonly tableName: string;
  readonly defaultValue?: unknown;
}

/** A value usable in a select projection: a column reference or SQL expression. */
export type SelectProjectionValue = SelectColumnRef | Sql;

/** Map of result key to selected column or expression, for `db.select({ ... })`. */
export type SelectProjection = Record<string, SelectProjectionValue>;

type ProjectionColumnValue<TColumn> = TColumn extends SqlExpression<infer TExpr>
  ? TExpr
  : TColumn extends { readonly defaultValue?: infer TDefault }
    ? (TDefault extends (...args: never[]) => infer TReturn ? TReturn
      : Exclude<TDefault, undefined>)
  : unknown;

/** Inferred row type for a projected select. */
export type InferProjection<TProjection extends SelectProjection> = {
  readonly [K in keyof TProjection]: ProjectionColumnValue<TProjection[K]>;
};

/** Materialized column belonging to a table definition. */
export type TableColumn<TTable extends TableDefinition> =
  TTable["columns"][keyof TTable["columns"]];

/** One-to-one or one-to-many relation shape. */
export type RelationMode = "one" | "many";

/** Explicit relation column mapping. */
export interface RelationConfig<
  TSource extends TableDefinition,
  TTarget extends TableDefinition,
> {
  readonly fields?: readonly TableColumn<TSource>[];
  readonly references?: readonly TableColumn<TTarget>[];
  readonly relationName?: string;
}

/** Relation metadata produced by {@link relations}. */
export interface RelationDefinition<
  TSource extends TableDefinition = AnyTableDefinition,
  TTarget extends TableDefinition = AnyTableDefinition,
  TMode extends RelationMode = RelationMode,
  TName extends string = string,
> {
  readonly kind: "relation";
  readonly mode: TMode;
  readonly name?: TName;
  readonly sourceTable: TSource;
  readonly targetTable: TTarget;
  readonly fields?: readonly TableColumn<TSource>[];
  readonly references?: readonly TableColumn<TTarget>[];
  readonly relationName?: string;
}

/** Relation map returned from a `relations(table, ...)` callback. */
export type RelationDefinitionMap = Record<
  string,
  RelationDefinition<any, any>
>;

type NamedRelationDefinitionMap<TConfig extends Record<string, unknown>> = {
  readonly [K in keyof TConfig]: TConfig[K] extends RelationDefinition<
    infer TSource,
    infer TTarget,
    infer TMode,
    string
  > ? RelationDefinition<TSource, TTarget, TMode, Extract<K, string>>
    : never;
};

/** Relation collection for one table. */
export interface TableRelations<
  TTable extends TableDefinition = AnyTableDefinition,
  TRelations extends RelationDefinitionMap = RelationDefinitionMap,
> {
  readonly kind: "table_relations";
  readonly table: TTable;
  readonly relations: TRelations;
}

/** Helpers passed to {@link relations}. */
export interface RelationHelpers<TSource extends TableDefinition> {
  one<TTarget extends TableDefinition>(
    table: TTarget,
    config: RelationConfig<TSource, TTarget>,
  ): RelationDefinition<TSource, TTarget, "one">;

  many<TTarget extends TableDefinition>(
    table: TTarget,
    config?: RelationConfig<TSource, TTarget>,
  ): RelationDefinition<TSource, TTarget, "many">;
}

/** Column selection accepted by relational queries. */
export type RelationalColumnSelection<TTable extends TableDefinition> = Partial<
  Record<keyof InferSelect<TTable>, boolean>
>;

type RelationsForTable<
  TTable extends TableDefinition,
  TRelations extends RelationsList,
> = TRelations[number] extends infer TRelationGroup ? TRelationGroup extends {
    readonly table: infer TRelationTable;
    readonly relations: infer TRelationMap;
  }
    ? TRelationTable extends TTable
      ? TRelationMap extends RelationDefinitionMap ? TRelationMap
      : never
    : never
  : RelationDefinitionMap
  : RelationDefinitionMap;

type TrueSelectionKeys<TSelection> = {
  [K in keyof TSelection]: TSelection[K] extends true ? K : never;
}[keyof TSelection];

type FalseSelectionKeys<TSelection> = {
  [K in keyof TSelection]: TSelection[K] extends false ? K : never;
}[keyof TSelection];

type SelectableKeys<TTable, TKeys> = TTable extends TableDefinition
  ? Extract<TKeys, keyof InferSelect<TTable>>
  : never;

type SelectedRelationalColumns<TTable, TSelection> = TTable extends
  TableDefinition ? [TSelection] extends [never] ? Partial<InferSelect<TTable>>
  : TSelection extends Record<string, boolean>
    ? [TrueSelectionKeys<TSelection>] extends [never] ? Omit<
        InferSelect<TTable>,
        SelectableKeys<TTable, FalseSelectionKeys<TSelection>>
      >
    : Pick<
      InferSelect<TTable>,
      SelectableKeys<TTable, TrueSelectionKeys<TSelection>>
    >
  : InferSelect<TTable>
  : never;

type RelationTarget<TValue> = TValue extends
  { readonly targetTable: infer TTarget }
  ? TTarget extends TableDefinition ? TTarget : AnyTableDefinition
  : AnyTableDefinition;

type RelationConfigValue<TValue> = [TValue] extends [never]
  ? Record<never, never>
  : TValue extends true | false | null | undefined ? Record<never, never>
  : TValue;

type RelationObjectFallback<TRelation> = Partial<
  InferSelect<RelationTarget<TRelation>>
>;

type RelationResultValue<
  TRelation,
  TRelations extends RelationsList,
  TWithValue,
> = TRelation extends {
  readonly mode: infer TMode;
} ? TMode extends "many" ? Array<
      | RelationalQueryResult<
        RelationTarget<TRelation>,
        TRelations,
        RelationConfigValue<TWithValue>
      >
      | RelationObjectFallback<TRelation>
    >
  :
    | RelationalQueryResult<
      RelationTarget<TRelation>,
      TRelations,
      RelationConfigValue<TWithValue>
    >
    | RelationObjectFallback<TRelation>
    | null
  : never;

type RelationalWithResult<
  TRelationMap extends RelationDefinitionMap,
  TRelations extends RelationsList,
  TWith,
> = TWith extends Record<string, unknown> ? {
    readonly [
      K in keyof TWith & keyof TRelationMap as TWith[K] extends
        false | null | undefined ? never : K
    ]: RelationResultValue<TRelationMap[K], TRelations, TWith[K]>;
  }
  : Record<never, never>;

/** Options accepted by `db.query.<table>.findMany/findFirst`. */
export interface RelationalFindOptions<
  TTable extends TableDefinition,
  TRelationMap extends RelationDefinitionMap = RelationDefinitionMap,
  TRelations extends RelationsList = RelationsList,
> {
  readonly columns?: RelationalColumnSelection<TTable>;
  readonly with?: {
    readonly [K in keyof TRelationMap]?:
      | true
      | false
      | RelationalFindOptions<
        RelationTarget<TRelationMap[K]>,
        RelationsForTable<RelationTarget<TRelationMap[K]>, TRelations>,
        TRelations
      >;
  };
  readonly where?: Condition;
  readonly orderBy?: unknown | readonly unknown[];
  readonly limit?: number;
  readonly offset?: number;
}

/** Result type for relational queries after `columns` and `with` are applied. */
export type RelationalQueryResult<
  TTable extends TableDefinition,
  TRelations extends RelationsList,
  TConfig,
> =
  & SelectedRelationalColumns<
    TTable,
    TConfig extends { readonly columns?: infer TColumns } ? TColumns : never
  >
  & RelationalWithResult<
    RelationsForTable<TTable, TRelations>,
    TRelations,
    TConfig extends { readonly with?: infer TWith } ? TWith : never
  >;

/** Query helpers exposed at `db.query.<table>`. */
export interface RelationalTableQuery<
  TTable extends TableDefinition,
  TRelations extends RelationsList = RelationsList,
> {
  findMany<
    TConfig extends RelationalFindOptions<
      TTable,
      RelationsForTable<TTable, TRelations>,
      TRelations
    > = Record<never, never>,
  >(
    config?: TConfig,
  ): Promise<Array<RelationalQueryResult<TTable, TRelations, TConfig>>>;

  findFirst<
    TConfig extends RelationalFindOptions<
      TTable,
      RelationsForTable<TTable, TRelations>,
      TRelations
    > = Record<never, never>,
  >(
    config?: TConfig,
  ): Promise<RelationalQueryResult<TTable, TRelations, TConfig> | undefined>;
}

/** Fluent builder for `SELECT` queries. */
export interface SelectBuilder<TTable, TResult> {
  from<TNewTable extends TableDefinition>(
    table: TNewTable,
  ): SelectBuilder<
    TNewTable,
    unknown extends TResult ? InferSelect<TNewTable> : TResult
  >;

  /** Emits `SELECT DISTINCT`. */
  distinct(): SelectBuilder<TTable, TResult>;

  innerJoin(
    table: TableDefinition,
    on: Condition,
  ): SelectBuilder<TTable, TResult>;

  leftJoin(
    table: TableDefinition,
    on: Condition,
  ): SelectBuilder<TTable, TResult>;

  rightJoin(
    table: TableDefinition,
    on: Condition,
  ): SelectBuilder<TTable, TResult>;

  fullJoin(
    table: TableDefinition,
    on: Condition,
  ): SelectBuilder<TTable, TResult>;

  where(condition: Condition): SelectBuilder<TTable, TResult>;

  /** Groups by one or more columns or SQL expressions. */
  groupBy(...columns: unknown[]): SelectBuilder<TTable, TResult>;

  /** Filters grouped rows (`HAVING`). */
  having(condition: Condition): SelectBuilder<TTable, TResult>;

  /** Orders by `(column, direction)`. */
  orderBy(
    column: unknown,
    direction: "asc" | "desc",
  ): SelectBuilder<TTable, TResult>;
  /** Orders by one or more `asc()`/`desc()` terms or bare columns (ascending). */
  orderBy(...terms: unknown[]): SelectBuilder<TTable, TResult>;

  limit(count: number): SelectBuilder<TTable, TResult>;

  offset(count: number): SelectBuilder<TTable, TResult>;

  toSql(): Sql;

  execute(): Promise<TResult[]>;
}

/** Fluent builder for `INSERT` queries. */
export interface InsertBuilder<
  TTable extends TableDefinition,
  TReturn = InferSelect<TTable>,
> {
  values(
    value: InferInsert<TTable> | InferInsert<TTable>[],
  ): InsertBuilder<TTable, TReturn>;

  /** `ON CONFLICT [(target)] DO NOTHING`. */
  onConflictDoNothing(
    config?: { readonly target?: unknown | readonly unknown[] },
  ): InsertBuilder<TTable, TReturn>;

  /** `ON CONFLICT (target) DO UPDATE SET ... [WHERE ...]` (upsert). */
  onConflictDoUpdate(
    config: {
      readonly target: unknown | readonly unknown[];
      readonly set: Partial<InferInsert<TTable>>;
      readonly where?: Condition;
    },
  ): InsertBuilder<TTable, TReturn>;

  returning(): InsertBuilder<TTable, InferSelect<TTable>>;
  returning<TProjection extends SelectProjection>(
    projection: TProjection,
  ): InsertBuilder<TTable, InferProjection<TProjection>>;

  toSql(): Sql;

  execute(): Promise<OrmQueryResult<TReturn>>;
}

/** Fluent builder for `UPDATE` queries. */
export interface UpdateBuilder<
  TTable extends TableDefinition,
  TReturn = InferSelect<TTable>,
> {
  set(
    values: Partial<InferInsert<TTable>>,
  ): UpdateBuilder<TTable, TReturn>;

  where(condition: Condition): UpdateBuilder<TTable, TReturn>;

  unsafeAllowAllRows(): UpdateBuilder<TTable, TReturn>;

  returning(): UpdateBuilder<TTable, InferSelect<TTable>>;
  returning<TProjection extends SelectProjection>(
    projection: TProjection,
  ): UpdateBuilder<TTable, InferProjection<TProjection>>;

  toSql(): Sql;

  execute(): Promise<OrmQueryResult<TReturn>>;
}

/** Fluent builder for `DELETE` queries. */
export interface DeleteBuilder<
  TTable extends TableDefinition,
  TReturn = InferSelect<TTable>,
> {
  where(condition: Condition): DeleteBuilder<TTable, TReturn>;

  unsafeAllowAllRows(): DeleteBuilder<TTable, TReturn>;

  returning(): DeleteBuilder<TTable, InferSelect<TTable>>;
  returning<TProjection extends SelectProjection>(
    projection: TProjection,
  ): DeleteBuilder<TTable, InferProjection<TProjection>>;

  toSql(): Sql;

  execute(): Promise<OrmQueryResult<TReturn>>;
}

/** Options for the in-memory ORM driver. */
export interface MemoryOrmDriverOptions {
  readonly tables?: Record<string, Array<Record<string, unknown>>>;
}

/** Options applied when building a schema snapshot from ORM tables. */
export interface CreateSchemaSnapshotOptions {
  readonly dialect?: SisalDialectName;
  readonly metadata?: Record<string, unknown>;
}

/** Input accepted by {@link createSchemaSnapshot}. */
export interface CreateSchemaSnapshotInput extends CreateSchemaSnapshotOptions {
  readonly tables: readonly TableDefinition[] | Record<string, TableDefinition>;
}

/** Options accepted when constructing an {@link OrmError}. */
export interface OrmErrorOptions {
  readonly code?: OrmErrorCode;
  readonly status?: number;
  readonly expose?: boolean;
  readonly severity?: "debug" | "info" | "warn" | "error" | "fatal";
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

/** Error thrown for schema, SQL, execution, and transaction failures. */
export class OrmError extends SisalError {
  constructor(message: string, options: OrmErrorOptions = {}) {
    super(message, {
      code: options.code ?? "ORM_UNKNOWN_ERROR",
      status: options.status ?? 500,
      expose: options.expose ?? false,
      severity: options.severity ?? "error",
      details: options.details,
      cause: options.cause,
    });
  }
}

interface ColumnsFactory {
  text(): ColumnBuilder<string | null>;
  /** Postgres `varchar`; pass `length` for `varchar(n)`. */
  varchar(length?: number): ColumnBuilder<string | null>;
  /** Postgres `char`; pass `length` for `char(n)`. */
  char(length?: number): ColumnBuilder<string | null>;
  integer(): ColumnBuilder<number | null>;
  smallint(): ColumnBuilder<number | null>;
  /** Postgres `bigint`. Typed as `string` to preserve 64-bit precision. */
  bigint(): ColumnBuilder<string | null>;
  /** Auto-incrementing `serial`; optional on insert. */
  serial(): ColumnBuilder<number | null, false, true>;
  /** Auto-incrementing `bigserial` (string-typed); optional on insert. */
  bigserial(): ColumnBuilder<string | null, false, true>;
  number(): ColumnBuilder<number | null>;
  /** Postgres `numeric`/`decimal`; string-typed to preserve precision. */
  numeric(precision?: number, scale?: number): ColumnBuilder<string | null>;
  /** Alias of {@link ColumnsFactory.numeric}. */
  decimal(precision?: number, scale?: number): ColumnBuilder<string | null>;
  real(): ColumnBuilder<number | null>;
  /** Postgres `double precision`. */
  doublePrecision(): ColumnBuilder<number | null>;
  boolean(): ColumnBuilder<boolean | null>;
  json<T = Record<string, unknown>>(): ColumnBuilder<T | null>;
  /** Postgres `jsonb`. */
  jsonb<T = Record<string, unknown>>(): ColumnBuilder<T | null>;
  date(): ColumnBuilder<Date | null>;
  /** Postgres `timestamp`; `{ withTimezone: true }` maps to `timestamptz`. */
  timestamp(
    options?: { readonly withTimezone?: boolean },
  ): ColumnBuilder<Date | null>;
  uuid(): ColumnBuilder<string | null>;
}

/**
 * Column builder factory for table schemas.
 *
 * Columns are **nullable by default** (matching SQL and Drizzle); call
 * `.notNull()` to require a value. `.primaryKey()` implies `.notNull()`.
 */
export const columns: ColumnsFactory = Object.freeze({
  text(): ColumnBuilder<string | null> {
    return createColumnBuilder<string>("text");
  },

  varchar(length?: number): ColumnBuilder<string | null> {
    return createColumnBuilder<string>(
      "varchar",
      length === undefined ? {} : { length },
    );
  },

  char(length?: number): ColumnBuilder<string | null> {
    return createColumnBuilder<string>(
      "char",
      length === undefined ? {} : { length },
    );
  },

  integer(): ColumnBuilder<number | null> {
    return createColumnBuilder<number>("integer");
  },

  smallint(): ColumnBuilder<number | null> {
    return createColumnBuilder<number>("smallint");
  },

  bigint(): ColumnBuilder<string | null> {
    return createColumnBuilder<string>("bigint");
  },

  serial(): ColumnBuilder<number | null, false, true> {
    return createSerialBuilder<number>("serial");
  },

  bigserial(): ColumnBuilder<string | null, false, true> {
    return createSerialBuilder<string>("bigserial");
  },

  number(): ColumnBuilder<number | null> {
    return createColumnBuilder<number>("number");
  },

  numeric(precision?: number, scale?: number): ColumnBuilder<string | null> {
    return createColumnBuilder<string>(
      "numeric",
      numericExtra(precision, scale),
    );
  },

  decimal(precision?: number, scale?: number): ColumnBuilder<string | null> {
    return createColumnBuilder<string>(
      "decimal",
      numericExtra(precision, scale),
    );
  },

  real(): ColumnBuilder<number | null> {
    return createColumnBuilder<number>("real");
  },

  doublePrecision(): ColumnBuilder<number | null> {
    return createColumnBuilder<number>("double");
  },

  boolean(): ColumnBuilder<boolean | null> {
    return createColumnBuilder<boolean>("boolean");
  },

  json<T = Record<string, unknown>>(): ColumnBuilder<T | null> {
    return createColumnBuilder<T>("json");
  },

  jsonb<T = Record<string, unknown>>(): ColumnBuilder<T | null> {
    return createColumnBuilder<T>("jsonb");
  },

  date(): ColumnBuilder<Date | null> {
    return createColumnBuilder<Date>("date");
  },

  timestamp(
    options: { readonly withTimezone?: boolean } = {},
  ): ColumnBuilder<Date | null> {
    return createColumnBuilder<Date>(
      options.withTimezone ? "timestamptz" : "timestamp",
    );
  },

  uuid(): ColumnBuilder<string | null> {
    return createColumnBuilder<string>("uuid");
  },
});

/** Defines a typed table schema. */
export function defineTable<TColumns extends TableColumns>(
  name: TableName,
  tableColumns: TColumns,
  options: {
    readonly schema?: string;
  } = {},
): TableDefinition<TColumns> {
  const tableName = normalizeTableName(name);
  const schema = options.schema === undefined
    ? undefined
    : normalizeTableName(options.schema);
  const finalColumns: Record<string, unknown> = {};

  for (const [propertyName, builder] of Object.entries(tableColumns)) {
    if (!isColumnBuilder(builder)) {
      throw new OrmError("Table column must be a ColumnBuilder", {
        code: "ORM_INVALID_COLUMN",
        details: { table: tableName, propertyName },
      });
    }

    const columnName = normalizeColumnName(
      builder.definition.name ?? propertyName,
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

  return Object.freeze({
    kind: "table",
    name: tableName,
    ...(schema === undefined ? {} : { schema }),
    columns: Object.freeze(finalColumns),
  }) as TableDefinition<TColumns>;
}

/** Defines named relations for a table, Drizzle-style. */
export function relations<
  TTable extends TableDefinition,
  const TConfig extends Record<string, unknown>,
>(
  table: TTable,
  build: (helpers: RelationHelpers<TTable>) => TConfig,
): TableRelations<TTable, NamedRelationDefinitionMap<TConfig>> {
  assertTable(table);

  const helpers: RelationHelpers<TTable> = Object.freeze({
    one<TTarget extends TableDefinition>(
      targetTable: TTarget,
      config: RelationConfig<TTable, TTarget>,
    ): RelationDefinition<TTable, TTarget, "one"> {
      assertTable(targetTable);
      return Object.freeze({
        kind: "relation",
        mode: "one",
        sourceTable: table,
        targetTable,
        ...(config.fields === undefined ? {} : { fields: config.fields }),
        ...(config.references === undefined
          ? {}
          : { references: config.references }),
        ...(config.relationName === undefined
          ? {}
          : { relationName: config.relationName }),
      });
    },

    many<TTarget extends TableDefinition>(
      targetTable: TTarget,
      config: RelationConfig<TTable, TTarget> = {},
    ): RelationDefinition<TTable, TTarget, "many"> {
      assertTable(targetTable);
      return Object.freeze({
        kind: "relation",
        mode: "many",
        sourceTable: table,
        targetTable,
        ...(config.fields === undefined ? {} : { fields: config.fields }),
        ...(config.references === undefined
          ? {}
          : { references: config.references }),
        ...(config.relationName === undefined
          ? {}
          : { relationName: config.relationName }),
      });
    },
  });

  const built = build(helpers);
  const namedRelations: Record<string, RelationDefinition> = {};

  for (const [name, relation] of Object.entries(built)) {
    assertRelationDefinition(relation);
    if (relation.sourceTable.name !== table.name) {
      throw new OrmError("Relation source table does not match", {
        code: "ORM_INVALID_QUERY",
        details: { table: table.name, relation: name },
      });
    }
    namedRelations[name] = Object.freeze({ ...relation, name });
  }

  return Object.freeze({
    kind: "table_relations",
    table,
    relations: Object.freeze(namedRelations),
  }) as TableRelations<TTable, NamedRelationDefinitionMap<TConfig>>;
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

/** SQL tagged template that keeps interpolated values as parameters. */
export function sql(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Sql {
  const chunks: SqlChunk[] = [];

  for (let index = 0; index < strings.length; index += 1) {
    const text = strings[index];

    if (text.length > 0) {
      chunks.push({ kind: "text", value: text });
    }

    if (index < values.length) {
      const value = values[index];

      if (isSql(value)) {
        chunks.push({ kind: "sql", value });
      } else {
        chunks.push({ kind: "param", value: serializeSqlValue(value) });
      }
    }
  }

  return makeSql(chunks);
}

/**
 * Creates an unsafe raw SQL fragment.
 *
 * `raw()` does not sanitize input. Only use it with trusted SQL literals.
 */
export function raw(value: string): Sql {
  if (typeof value !== "string") {
    throw new OrmError("Raw SQL must be a string", {
      code: "ORM_INVALID_SQL",
    });
  }

  return makeSql([{ kind: "raw", value }]);
}

/** Creates a validated SQL identifier fragment. */
export function identifier(value: string): Sql {
  validateIdentifierPath(value, "ORM_INVALID_SQL");
  return makeSql([{ kind: "identifier", value }]);
}

/** Joins SQL fragments with a separator. */
export function joinSql(
  items: Sql[],
  separator: Sql = raw(", "),
): Sql {
  const chunks: SqlChunk[] = [];

  for (let index = 0; index < items.length; index += 1) {
    if (index > 0) {
      chunks.push({ kind: "sql", value: separator });
    }

    chunks.push({ kind: "sql", value: items[index] });
  }

  return makeSql(chunks);
}

/** Returns an empty SQL fragment. */
export function emptySql(): Sql {
  return makeSql([]);
}

/** Renders a SQL fragment into driver text and parameter array. */
export function renderSql(
  query: Sql,
  options: {
    readonly dialect?: SqlDialect;
  } = {},
): SqlQuery {
  if (!isSql(query)) {
    throw new OrmError("Expected a SQL fragment", {
      code: "ORM_INVALID_SQL",
    });
  }

  const state: RenderState = {
    text: "",
    params: [],
    dialect: options.dialect ?? "generic",
  };

  renderSqlInto(query, state);

  return {
    text: state.text,
    params: state.params,
  };
}

/** Normalizes manual or builder SQL into the driver query contract. */
export function normalizeSqlInput(
  query: SqlInput,
  params: readonly SqlParameter[] | undefined = undefined,
  dialect: SqlDialect = "generic",
): SqlQuery {
  if (isSql(query)) {
    if (params !== undefined && params.length > 0) {
      throw new OrmError("SQL fragments cannot receive external params", {
        code: "ORM_INVALID_SQL",
      });
    }

    return renderSql(query, { dialect });
  }

  if (typeof query === "string") {
    return {
      text: query,
      params: params === undefined ? [] : [...params],
    };
  }

  if (isSqlQuery(query)) {
    if (params !== undefined && params.length > 0) {
      throw new OrmError("SqlQuery cannot receive external params", {
        code: "ORM_INVALID_SQL",
      });
    }

    return {
      text: query.text,
      params: [...query.params],
    };
  }

  throw new OrmError("Expected SQL input", {
    code: "ORM_INVALID_SQL",
  });
}

/** Quotes and validates a SQL identifier for a dialect. */
export function quoteIdentifier(
  name: string,
  dialect: SqlDialect = "generic",
): string {
  const normalized = validateIdentifierPath(name, "ORM_INVALID_SQL");
  const quote = dialect === "mysql" ? "`" : '"';

  return normalized
    .split(".")
    .map((part) => `${quote}${part}${quote}`)
    .join(".");
}

/** `column = value` SQL condition. */
export function eq(column: unknown, value: unknown): Condition {
  return binaryCondition(column, "=", value);
}

/** `column <> value` SQL condition. */
export function ne(column: unknown, value: unknown): Condition {
  return binaryCondition(column, "<>", value);
}

/** `column > value` SQL condition. */
export function gt(column: unknown, value: unknown): Condition {
  return binaryCondition(column, ">", value);
}

/** `column >= value` SQL condition. */
export function gte(column: unknown, value: unknown): Condition {
  return binaryCondition(column, ">=", value);
}

/** `column < value` SQL condition. */
export function lt(column: unknown, value: unknown): Condition {
  return binaryCondition(column, "<", value);
}

/** `column <= value` SQL condition. */
export function lte(column: unknown, value: unknown): Condition {
  return binaryCondition(column, "<=", value);
}

/** `column LIKE value` SQL condition. */
export function like(column: unknown, value: unknown): Condition {
  return binaryCondition(column, "like", value);
}

/** Case-insensitive `ILIKE` match (PostgreSQL-oriented). */
export function ilike(column: unknown, value: unknown): Condition {
  return binaryCondition(column, "ilike", value);
}

/** `column NOT LIKE value` SQL condition. */
export function notLike(column: unknown, value: unknown): Condition {
  return binaryCondition(column, "not like", value);
}

/** Case-insensitive `NOT ILIKE` match (PostgreSQL-oriented). */
export function notIlike(column: unknown, value: unknown): Condition {
  return binaryCondition(column, "not ilike", value);
}

/** `column BETWEEN min AND max` SQL condition (inclusive). */
export function between(
  column: unknown,
  min: unknown,
  max: unknown,
): Condition {
  return betweenCondition(column, min, max, false);
}

/** `column NOT BETWEEN min AND max` SQL condition. */
export function notBetween(
  column: unknown,
  min: unknown,
  max: unknown,
): Condition {
  return betweenCondition(column, min, max, true);
}

/**
 * `column IN (...)`. Each value is a bound parameter. An empty array yields a
 * constant always-false condition (`1 = 0`) rather than invalid `IN ()` SQL, so
 * dynamic filters with no values are safe.
 */
export function inArray(
  column: unknown,
  values: readonly unknown[],
): Condition {
  return inArrayCondition(column, values, false);
}

/** `column NOT IN (...)`. An empty array yields a constant always-true condition. */
export function notInArray(
  column: unknown,
  values: readonly unknown[],
): Condition {
  return inArrayCondition(column, values, true);
}

/** `column IS NULL` SQL condition. */
export function isNull(column: unknown): Condition {
  return createCondition(sql`${columnToSql(column)} is null`);
}

/** `column IS NOT NULL` SQL condition. */
export function isNotNull(column: unknown): Condition {
  return createCondition(sql`${columnToSql(column)} is not null`);
}

/** Combines conditions with SQL `AND`, ignoring nullish values. */
export function and(
  ...conditions: Array<Condition | null | undefined>
): Condition {
  return combineConditions("and", conditions);
}

/** Combines conditions with SQL `OR`, ignoring nullish values. */
export function or(
  ...conditions: Array<Condition | null | undefined>
): Condition {
  return combineConditions("or", conditions);
}

/** Negates a SQL condition with `NOT (...)`. */
export function not(condition: Condition): Condition {
  assertCondition(condition);
  return createCondition(sql`not (${condition.sql})`);
}

/** Ascending order term for `orderBy`, e.g. `orderBy(asc(users.columns.name))`. */
export function asc(column: unknown): Sql {
  return sql`${columnToSql(column)} asc`;
}

/** Descending order term for `orderBy`, e.g. `orderBy(desc(users.columns.id))`. */
export function desc(column: unknown): Sql {
  return sql`${columnToSql(column)} desc`;
}

/** `count(*)` (no argument) or `count(column)` aggregate expression. */
export function count(column?: unknown): SqlExpression<number> {
  const target = column === undefined ? raw("*") : columnToSql(column);
  return sql`count(${target})` as SqlExpression<number>;
}

/** `sum(column)` aggregate expression. */
export function sum(column: unknown): SqlExpression<number | null> {
  return sql`sum(${columnToSql(column)})` as SqlExpression<number | null>;
}

/** `avg(column)` aggregate expression. */
export function avg(column: unknown): SqlExpression<number | null> {
  return sql`avg(${columnToSql(column)})` as SqlExpression<number | null>;
}

/** `min(column)` aggregate expression. */
export function min<T = unknown>(column: unknown): SqlExpression<T | null> {
  return sql`min(${columnToSql(column)})` as SqlExpression<T | null>;
}

/** `max(column)` aggregate expression. */
export function max<T = unknown>(column: unknown): SqlExpression<T | null> {
  return sql`max(${columnToSql(column)})` as SqlExpression<T | null>;
}

/** Creates a database facade from a driver and dialect. */
export function createDatabase<
  TSchema extends DatabaseSchema = Record<never, AnyTableDefinition>,
  TRelations extends RelationsList = readonly [],
>(
  options: DatabaseOptions<TSchema, TRelations> = {},
): Database<TSchema, TRelations> {
  return new SisalDatabase<TSchema, TRelations>({
    driver: options.driver ?? noopOrmDriver(),
    dialect: options.dialect ?? "generic",
    logger: options.logger,
    ...(options.schema === undefined ? {} : { schema: options.schema }),
    ...(options.relations === undefined
      ? {}
      : { relations: options.relations }),
  });
}

/**
 * Creates a driver that never touches a real database.
 *
 * Useful for tests and scaffolding; it always returns empty result sets.
 */
export function noopOrmDriver(): OrmDriver {
  return {
    query<T = unknown>(_query: SqlQuery): Promise<OrmQueryResult<T>> {
      return Promise.resolve({ rows: [], rowCount: 0 });
    },

    execute(_query: SqlQuery): Promise<OrmQueryResult> {
      return Promise.resolve({ rows: [], rowCount: 0 });
    },

    transaction<T>(fn: (tx: OrmTransaction) => Promise<T>): Promise<T> {
      return fn(this);
    },

    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}

/** Creates a tiny in-memory driver that records no data and returns empty rows. */
export function memoryOrmDriver(
  _options: MemoryOrmDriverOptions = {},
): OrmDriver {
  const history: SqlQuery[] = [];

  return {
    query<T = unknown>(query: SqlQuery): Promise<OrmQueryResult<T>> {
      history.push(cloneSqlQuery(query));
      return Promise.resolve({ rows: [], rowCount: 0 });
    },

    execute(query: SqlQuery): Promise<OrmQueryResult> {
      history.push(cloneSqlQuery(query));
      return Promise.resolve({ rows: [], rowCount: 0 });
    },

    transaction<T>(fn: (tx: OrmTransaction) => Promise<T>): Promise<T> {
      return fn(this);
    },

    close(): Promise<void> {
      history.length = 0;
      return Promise.resolve();
    },
  };
}

/** Normalizes a table name. */
export function normalizeTableName(name: TableName): TableName {
  if (typeof name !== "string") {
    throw new OrmError("Table name must be a string", {
      code: "ORM_INVALID_TABLE",
    });
  }

  return validateIdentifierPath(name.trim(), "ORM_INVALID_TABLE");
}

/** Normalizes a simple column name. */
export function normalizeColumnName(name: ColumnName): ColumnName {
  if (typeof name !== "string") {
    throw new OrmError("Column name must be a string", {
      code: "ORM_INVALID_COLUMN",
    });
  }

  const normalized = name.trim();

  if (!isValidIdentifierPart(normalized)) {
    throw new OrmError("Column name is invalid", {
      code: "ORM_INVALID_COLUMN",
      details: { name },
    });
  }

  return normalized;
}

/** Creates a named column definition from metadata. */
export function createColumn<T>(
  name: ColumnName,
  definition: ColumnDefinition<T>,
): ColumnDefinition<T> & { readonly name: ColumnName } {
  return Object.freeze({
    ...cloneColumnDefinition(definition),
    name: normalizeColumnName(name),
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

/** Returns true when a value has the public column definition shape. */
export function isColumn(
  value: unknown,
): value is ColumnDefinition<unknown> & {
  readonly name: ColumnName;
  readonly tableName: string;
  readonly propertyName?: string;
} {
  return isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.tableName === "string" &&
    typeof value.dataType === "string";
}

/** Returns true when a value is a Sisal SQL fragment. */
export function isSql(value: unknown): value is Sql {
  return isRecord(value) && value.kind === "sql" && Array.isArray(value.chunks);
}

/** Returns true when a value is driver-ready SQL text and parameters. */
export function isSqlQuery(value: unknown): value is SqlQuery {
  return isRecord(value) && typeof value.text === "string" &&
    Array.isArray(value.params);
}

/** Converts a JS value into a SQL parameter. */
export function serializeSqlValue(value: unknown): SqlParameter {
  if (value === undefined) {
    return null;
  }

  if (
    typeof value === "string" || typeof value === "number" ||
    typeof value === "boolean" || value === null ||
    value instanceof Date || value instanceof Uint8Array
  ) {
    return value;
  }

  if (isSql(value)) {
    throw new OrmError("SQL fragments cannot be serialized as parameters", {
      code: "ORM_SERIALIZATION_FAILED",
    });
  }

  if (Array.isArray(value)) {
    return value;
  }

  if (isRecord(value)) {
    return value;
  }

  throw new OrmError("SQL value is not serializable", {
    code: "ORM_SERIALIZATION_FAILED",
    details: { type: typeof value },
  });
}

/** Converts a SQL fragment or condition into SQL. */
export function toSql(query: Sql | Condition): Sql {
  if (isSql(query)) {
    return query;
  }

  if (isCondition(query)) {
    return query.sql;
  }

  throw new OrmError("Value cannot be converted to SQL", {
    code: "ORM_INVALID_SQL",
  });
}

class SisalColumnBuilder<
  T,
  TOptional extends boolean,
  THasDefault extends boolean,
> implements ColumnBuilder<T, TOptional, THasDefault> {
  readonly definition: ColumnDefinition<T>;
  readonly optionalInsert: TOptional;
  readonly defaultInsert: THasDefault;

  constructor(
    definition: ColumnDefinition<T>,
    optionalInsert: TOptional,
    defaultInsert: THasDefault,
  ) {
    this.definition = Object.freeze(cloneColumnDefinition(definition));
    this.optionalInsert = optionalInsert;
    this.defaultInsert = defaultInsert;
  }

  named(name: string): ColumnBuilder<T, TOptional, THasDefault> {
    return new SisalColumnBuilder(
      { ...this.definition, name: normalizeColumnName(name) },
      this.optionalInsert,
      this.defaultInsert,
    );
  }

  notNull(): ColumnBuilder<NonNullable<T>, TOptional, THasDefault> {
    return new SisalColumnBuilder(
      { ...this.definition, nullable: false } as ColumnDefinition<
        NonNullable<T>
      >,
      this.optionalInsert,
      this.defaultInsert,
    );
  }

  nullable(): ColumnBuilder<T | null, TOptional, THasDefault> {
    return new SisalColumnBuilder(
      { ...this.definition, nullable: true } as ColumnDefinition<T | null>,
      this.optionalInsert,
      this.defaultInsert,
    );
  }

  optional(): ColumnBuilder<T | undefined, true, THasDefault> {
    return new SisalColumnBuilder(
      this.definition as ColumnDefinition<T | undefined>,
      true,
      this.defaultInsert,
    );
  }

  default(value: T | (() => T)): ColumnBuilder<T, TOptional, true> {
    return new SisalColumnBuilder(
      {
        ...this.definition,
        hasDefault: true,
        defaultValue: value,
      },
      this.optionalInsert,
      true,
    );
  }

  primaryKey(): ColumnBuilder<NonNullable<T>, TOptional, THasDefault> {
    // A primary key is never null, so it implies NOT NULL.
    return new SisalColumnBuilder(
      {
        ...this.definition,
        primaryKey: true,
        nullable: false,
      } as ColumnDefinition<NonNullable<T>>,
      this.optionalInsert,
      this.defaultInsert,
    );
  }

  unique(): ColumnBuilder<T, TOptional, THasDefault> {
    return new SisalColumnBuilder(
      { ...this.definition, unique: true },
      this.optionalInsert,
      this.defaultInsert,
    );
  }

  references(
    table: string,
    column: string,
  ): ColumnBuilder<T, TOptional, THasDefault> {
    return new SisalColumnBuilder(
      {
        ...this.definition,
        references: {
          table: normalizeTableName(table),
          column: normalizeColumnName(column),
        },
      },
      this.optionalInsert,
      this.defaultInsert,
    );
  }

  array(): ColumnBuilder<ColumnArray<T>, TOptional, THasDefault> {
    return new SisalColumnBuilder(
      { ...this.definition, array: true } as ColumnDefinition<ColumnArray<T>>,
      this.optionalInsert,
      this.defaultInsert,
    );
  }

  $onUpdate(
    fn: () => NonNullable<T>,
  ): ColumnBuilder<T, TOptional, THasDefault> {
    return new SisalColumnBuilder(
      { ...this.definition, onUpdate: fn },
      this.optionalInsert,
      this.defaultInsert,
    );
  }
}

interface SisalDatabaseOptions<
  TSchema extends DatabaseSchema,
  TRelations extends RelationsList,
> {
  readonly driver: OrmDriver;
  readonly dialect: SqlDialect;
  readonly logger?: Logger;
  readonly schema?: TSchema;
  readonly relations?: TRelations;
}

class SisalDatabase<
  TSchema extends DatabaseSchema = Record<never, AnyTableDefinition>,
  TRelations extends RelationsList = readonly [],
> implements Database<TSchema, TRelations> {
  readonly dialect: SqlDialect;
  readonly query: DatabaseQuery<TSchema, TRelations>;
  readonly #driver: OrmDriver;
  readonly #logger?: Logger;
  readonly #schema?: TSchema;
  readonly #relations?: TRelations;
  readonly #relationRegistry: RelationRegistry;

  constructor(options: SisalDatabaseOptions<TSchema, TRelations>) {
    this.#driver = options.driver;
    this.dialect = options.dialect;
    this.#logger = options.logger;
    this.#schema = options.schema;
    this.#relations = options.relations;
    this.#relationRegistry = createRelationRegistry(options.relations ?? []);
    this.query = createDatabaseQuery<TSchema, TRelations>(
      (query, params) => this.#query(query, params),
      this,
      this.#schema,
      this.#relationRegistry,
    );
  }

  async execute<T = unknown>(
    query: SqlInput,
    params?: readonly SqlParameter[],
  ): Promise<OrmQueryResult<T>> {
    return await this.#run<T>("execute", query, params, async (rendered) => {
      const result = await this.#driver.execute(rendered);
      return result as OrmQueryResult<T>;
    });
  }

  async #query<T = unknown>(
    query: SqlInput,
    params?: readonly SqlParameter[],
  ): Promise<OrmQueryResult<T>> {
    return await this.#run<T>(
      "query",
      query,
      params,
      (rendered) => this.#driver.query<T>(rendered),
    );
  }

  select(): SelectBuilder<unknown, unknown>;
  select<TProjection extends SelectProjection>(
    projection: TProjection,
  ): SelectBuilder<unknown, InferProjection<TProjection>>;
  select(
    projection?: SelectProjection,
  ): SelectBuilder<unknown, unknown> {
    return new SisalSelectBuilder<unknown, unknown>(this, {
      joins: [],
      ...(projection === undefined ? {} : { projection }),
    });
  }

  insert<TTable extends TableDefinition>(
    table: TTable,
  ): InsertBuilder<TTable> {
    assertTable(table);
    return new SisalInsertBuilder(this, table);
  }

  update<TTable extends TableDefinition>(
    table: TTable,
  ): UpdateBuilder<TTable> {
    assertTable(table);
    return new SisalUpdateBuilder(this, table);
  }

  delete<TTable extends TableDefinition>(
    table: TTable,
  ): DeleteBuilder<TTable> {
    assertTable(table);
    return new SisalDeleteBuilder(this, table);
  }

  async transaction<T>(
    fn: (tx: Database<TSchema, TRelations>) => Promise<T>,
  ): Promise<T> {
    try {
      if (this.#driver.transaction === undefined) {
        return await fn(this);
      }

      return await this.#driver.transaction(async (tx) => {
        const transactionDatabase = new SisalDatabase<TSchema, TRelations>({
          driver: transactionToDriver(tx),
          dialect: this.dialect,
          logger: this.#logger,
          ...(this.#schema === undefined ? {} : { schema: this.#schema }),
          ...(this.#relations === undefined
            ? {}
            : { relations: this.#relations }),
        });

        return await fn(transactionDatabase);
      });
    } catch (error) {
      throw new OrmError("ORM transaction failed", {
        code: "ORM_TRANSACTION_FAILED",
        cause: error,
      });
    }
  }

  async close(): Promise<void> {
    await this.#driver.close?.();
  }

  async #run<T>(
    operation: "query" | "execute",
    query: SqlInput,
    params: readonly SqlParameter[] | undefined,
    run: (rendered: SqlQuery) => Promise<OrmQueryResult<T>>,
  ): Promise<OrmQueryResult<T>> {
    const rendered = normalizeSqlInput(query, params, this.dialect);
    const startedAt = performance.now();

    this.#debug({ sql: rendered.text }, "orm query started");

    try {
      const result = await run(rendered);
      this.#debug(
        {
          rowCount: result.rowCount ?? result.rows.length,
          durationMs: elapsedMs(startedAt),
        },
        "orm query completed",
      );
      return result;
    } catch (error) {
      this.#error({ sql: rendered.text }, "orm query failed");

      if (error instanceof OrmError) {
        throw error;
      }

      throw new OrmError(`ORM ${operation} failed`, {
        code: "ORM_EXECUTE_FAILED",
        details: { sql: rendered.text },
        cause: error,
      });
    }
  }

  #debug(record: Record<string, unknown>, message: string): void {
    try {
      this.#logger?.debug(record, message);
    } catch {
      // Logging must not break queries.
    }
  }

  #error(record: Record<string, unknown>, message: string): void {
    try {
      this.#logger?.error(record, message);
    } catch {
      // Logging must not break queries.
    }
  }
}

interface RelationRegistry {
  readonly bySourceTable: Map<string, Map<string, RelationDefinition>>;
}

type RelationalColumnsRuntime = Record<string, boolean>;

interface RelationalFindRuntime {
  readonly columns?: RelationalColumnsRuntime;
  readonly with?: Record<string, unknown>;
  readonly where?: Condition;
  readonly orderBy?: unknown | readonly unknown[];
  readonly limit?: number;
  readonly offset?: number;
}

interface LoadedRelationalRow {
  readonly raw: Record<string, unknown>;
  readonly value: Record<string, unknown>;
}

interface ResolvedRelationColumns {
  readonly sourceColumns: readonly TableColumn<TableDefinition>[];
  readonly targetColumns: readonly TableColumn<TableDefinition>[];
  readonly sourceKeys: readonly string[];
  readonly targetKeys: readonly string[];
}

interface RelationRequest {
  readonly name: string;
  readonly relation: RelationDefinition;
  readonly config: RelationalFindRuntime;
  readonly columns: ResolvedRelationColumns;
}

interface RelationalSelection {
  readonly visibleKeys: readonly string[];
  readonly queryKeys: readonly string[];
  readonly projection: SelectProjection;
}

const relationalSyntheticColumn = "__sisal_row";

function createDatabaseQuery<
  TSchema extends DatabaseSchema,
  TRelations extends RelationsList,
>(
  rawQuery: RawQueryExecutor,
  database: Database<TSchema, TRelations>,
  schema: TSchema | undefined,
  registry: RelationRegistry,
): DatabaseQuery<TSchema, TRelations> {
  const query = rawQuery as DatabaseQuery<TSchema, TRelations>;

  if (schema !== undefined) {
    for (const [name, table] of Object.entries(schema)) {
      assertTable(table);
      if (name in query) {
        throw new OrmError("Schema key conflicts with db.query", {
          code: "ORM_INVALID_QUERY",
          details: { key: name },
        });
      }
      Object.defineProperty(query, name, {
        enumerable: true,
        value: new SisalRelationalTableQuery(database, table, registry),
      });
    }
  }

  return Object.freeze(query);
}

function createRelationRegistry(
  tableRelations: readonly TableRelations[],
): RelationRegistry {
  const bySourceTable = new Map<string, Map<string, RelationDefinition>>();

  for (const tableRelation of tableRelations) {
    if (!isTableRelations(tableRelation)) {
      throw new OrmError("Expected table relations", {
        code: "ORM_INVALID_QUERY",
      });
    }

    const map = bySourceTable.get(tableRelation.table.name) ?? new Map();

    for (const [name, relation] of Object.entries(tableRelation.relations)) {
      assertRelationDefinition(relation);
      if (map.has(name)) {
        throw new OrmError("Duplicate relation name", {
          code: "ORM_INVALID_QUERY",
          details: { table: tableRelation.table.name, relation: name },
        });
      }
      map.set(name, relation);
    }

    bySourceTable.set(tableRelation.table.name, map);
  }

  return Object.freeze({ bySourceTable });
}

class SisalRelationalTableQuery<
  TTable extends TableDefinition,
  TRelations extends RelationsList,
> implements RelationalTableQuery<TTable, TRelations> {
  readonly #database: Database;
  readonly #table: TTable;
  readonly #registry: RelationRegistry;

  constructor(
    database: Database,
    table: TTable,
    registry: RelationRegistry,
  ) {
    this.#database = database;
    this.#table = table;
    this.#registry = registry;
  }

  async findMany<
    TConfig extends RelationalFindOptions<
      TTable,
      RelationsForTable<TTable, TRelations>,
      TRelations
    > = Record<never, never>,
  >(
    config?: TConfig,
  ): Promise<Array<RelationalQueryResult<TTable, TRelations, TConfig>>> {
    const rows = await loadRelationalRows(
      this.#database,
      this.#table,
      this.#registry,
      normalizeRelationalFindConfig(config),
    );
    return rows.map((row) => row.value) as Array<
      RelationalQueryResult<TTable, TRelations, TConfig>
    >;
  }

  async findFirst<
    TConfig extends RelationalFindOptions<
      TTable,
      RelationsForTable<TTable, TRelations>,
      TRelations
    > = Record<never, never>,
  >(
    config?: TConfig,
  ): Promise<RelationalQueryResult<TTable, TRelations, TConfig> | undefined> {
    const rows = await loadRelationalRows(
      this.#database,
      this.#table,
      this.#registry,
      { ...normalizeRelationalFindConfig(config), limit: 1 },
    );
    return rows[0]?.value as
      | RelationalQueryResult<TTable, TRelations, TConfig>
      | undefined;
  }
}

async function loadRelationalRows(
  database: Database,
  table: TableDefinition,
  registry: RelationRegistry,
  config: RelationalFindRuntime,
  requiredKeys: readonly string[] = [],
): Promise<LoadedRelationalRow[]> {
  assertTable(table);
  const relationRequests = resolveRelationRequests(
    table,
    registry,
    config.with,
  );
  const requiredForRelations = relationRequests.flatMap((request) =>
    request.columns.sourceKeys
  );
  const selection = resolveRelationalSelection(table, config.columns, [
    ...requiredKeys,
    ...requiredForRelations,
  ]);

  let builder = database.select(selection.projection).from(table);

  if (config.where !== undefined) {
    builder = builder.where(config.where);
  }

  const orderTerms = normalizeRelationalOrderBy(config.orderBy);
  if (orderTerms.length > 0) {
    builder = builder.orderBy(...orderTerms);
  }

  if (config.limit !== undefined) {
    builder = builder.limit(config.limit);
  }

  if (config.offset !== undefined) {
    builder = builder.offset(config.offset);
  }

  const rows = await builder.execute() as Array<Record<string, unknown>>;
  const loadedRows = rows.map((row) => ({
    raw: row,
    value: pickRow(row, selection.visibleKeys),
  }));

  for (const request of relationRequests) {
    await attachRelation(database, registry, loadedRows, request);
  }

  return loadedRows;
}

async function attachRelation(
  database: Database,
  registry: RelationRegistry,
  parents: LoadedRelationalRow[],
  request: RelationRequest,
): Promise<void> {
  const parentKeys = uniqueRelationKeys(
    parents.map((parent) =>
      valuesForKeys(parent.raw, request.columns.sourceKeys)
    ),
  );

  if (parentKeys.length === 0) {
    for (const parent of parents) {
      parent.value[request.name] = request.relation.mode === "many" ? [] : null;
    }
    return;
  }

  const relationCondition = relationFilter(
    request.columns.targetColumns,
    parentKeys,
  );
  const childRows = await loadRelationalRows(
    database,
    request.relation.targetTable,
    registry,
    {
      ...request.config,
      where: request.config.where === undefined
        ? relationCondition
        : and(relationCondition, request.config.where),
    },
    request.columns.targetKeys,
  );
  const childGroups = new Map<string, LoadedRelationalRow[]>();

  for (const child of childRows) {
    const key = relationKey(
      valuesForKeys(child.raw, request.columns.targetKeys),
    );
    const group = childGroups.get(key) ?? [];
    group.push(child);
    childGroups.set(key, group);
  }

  for (const parent of parents) {
    const keyValues = valuesForKeys(parent.raw, request.columns.sourceKeys);
    if (hasNullishValue(keyValues)) {
      parent.value[request.name] = request.relation.mode === "many" ? [] : null;
      continue;
    }

    const group = childGroups.get(relationKey(keyValues)) ?? [];
    parent.value[request.name] = request.relation.mode === "many"
      ? group.map((child) => child.value)
      : group[0]?.value ?? null;
  }
}

function resolveRelationRequests(
  table: TableDefinition,
  registry: RelationRegistry,
  withConfig: Record<string, unknown> | undefined,
): RelationRequest[] {
  if (withConfig === undefined) {
    return [];
  }
  if (!isPlainRecord(withConfig)) {
    throw new OrmError("Relational with config must be an object", {
      code: "ORM_INVALID_QUERY",
    });
  }

  const relationMap = registry.bySourceTable.get(table.name) ?? new Map();
  const requests: RelationRequest[] = [];

  for (const [name, value] of Object.entries(withConfig)) {
    if (value === false || value === null || value === undefined) {
      continue;
    }

    const relation = relationMap.get(name);
    if (relation === undefined) {
      throw new OrmError("Unknown relation", {
        code: "ORM_INVALID_QUERY",
        details: { table: table.name, relation: name },
      });
    }

    requests.push({
      name,
      relation,
      config: value === true ? {} : normalizeRelationalFindConfig(value),
      columns: resolveRelationColumns(relation),
    });
  }

  return requests;
}

function resolveRelationColumns(
  relation: RelationDefinition,
): ResolvedRelationColumns {
  const sourceColumns = relation.fields;
  const targetColumns = relation.references;

  if (sourceColumns !== undefined || targetColumns !== undefined) {
    if (
      sourceColumns === undefined || targetColumns === undefined ||
      sourceColumns.length === 0 ||
      sourceColumns.length !== targetColumns.length
    ) {
      throw new OrmError("Relation fields and references must match", {
        code: "ORM_INVALID_QUERY",
        details: { relation: relation.name },
      });
    }

    return normalizeRelationColumns(relation, sourceColumns, targetColumns);
  }

  return inferRelationColumns(relation);
}

function normalizeRelationColumns(
  relation: RelationDefinition,
  sourceColumns: readonly TableColumn<TableDefinition>[],
  targetColumns: readonly TableColumn<TableDefinition>[],
): ResolvedRelationColumns {
  for (const column of sourceColumns) {
    assertColumnBelongsToTable(column, relation.sourceTable, "field");
  }
  for (const column of targetColumns) {
    assertColumnBelongsToTable(column, relation.targetTable, "reference");
  }

  return {
    sourceColumns,
    targetColumns,
    sourceKeys: sourceColumns.map(columnPropertyName),
    targetKeys: targetColumns.map(columnPropertyName),
  };
}

function inferRelationColumns(
  relation: RelationDefinition,
): ResolvedRelationColumns {
  if (relation.mode === "one") {
    for (const sourceColumn of Object.values(relation.sourceTable.columns)) {
      if (sourceColumn.references?.table !== relation.targetTable.name) {
        continue;
      }
      const targetColumn = findTableColumnByName(
        relation.targetTable,
        sourceColumn.references.column,
      );
      if (targetColumn !== undefined) {
        return normalizeRelationColumns(
          relation,
          [sourceColumn],
          [targetColumn],
        );
      }
    }
  } else {
    for (const targetColumn of Object.values(relation.targetTable.columns)) {
      if (targetColumn.references?.table !== relation.sourceTable.name) {
        continue;
      }
      const sourceColumn = findTableColumnByName(
        relation.sourceTable,
        targetColumn.references.column,
      );
      if (sourceColumn !== undefined) {
        return normalizeRelationColumns(
          relation,
          [sourceColumn],
          [targetColumn],
        );
      }
    }
  }

  throw new OrmError("Relation requires fields/references", {
    code: "ORM_INVALID_QUERY",
    details: {
      source: relation.sourceTable.name,
      target: relation.targetTable.name,
      relation: relation.name,
    },
  });
}

function relationFilter(
  targetColumns: readonly TableColumn<TableDefinition>[],
  keyValues: readonly (readonly unknown[])[],
): Condition {
  if (targetColumns.length === 1) {
    return inArray(
      targetColumns[0],
      keyValues.map((values) => values[0]),
    );
  }

  return or(
    ...keyValues.map((values) =>
      and(
        ...targetColumns.map((column, index) => eq(column, values[index])),
      )
    ),
  );
}

function resolveRelationalSelection(
  table: TableDefinition,
  columns: RelationalColumnsRuntime | undefined,
  requiredKeys: readonly string[],
): RelationalSelection {
  const allKeys = Object.keys(table.columns);
  const visibleKeys = visibleRelationalColumnKeys(table, columns, allKeys);
  const queryKeys = uniqueStrings([...visibleKeys, ...requiredKeys]);
  const projection: Record<string, SelectProjectionValue> = {};

  for (const key of queryKeys) {
    projection[key] = table.columns[key];
  }

  if (Object.keys(projection).length === 0) {
    projection[relationalSyntheticColumn] = raw("1");
  }

  return { visibleKeys, queryKeys, projection };
}

function visibleRelationalColumnKeys(
  table: TableDefinition,
  columns: RelationalColumnsRuntime | undefined,
  allKeys: readonly string[],
): string[] {
  if (columns === undefined) {
    return [...allKeys];
  }
  if (!isPlainRecord(columns)) {
    throw new OrmError("Relational columns config must be an object", {
      code: "ORM_INVALID_QUERY",
    });
  }

  const entries = Object.entries(columns);
  for (const [key, value] of entries) {
    assertTableColumn(table, key);
    if (typeof value !== "boolean") {
      throw new OrmError("Relational column selection must be boolean", {
        code: "ORM_INVALID_QUERY",
        details: { table: table.name, column: key },
      });
    }
  }

  const included = entries
    .filter(([, value]) => value === true)
    .map(([key]) => key);

  if (included.length > 0) {
    return included;
  }

  return allKeys.filter((key) => columns[key] !== false);
}

function normalizeRelationalFindConfig(value: unknown): RelationalFindRuntime {
  if (value === undefined) {
    return {};
  }
  if (!isPlainRecord(value)) {
    throw new OrmError("Relational query config must be an object", {
      code: "ORM_INVALID_QUERY",
    });
  }

  return {
    ...(value.columns === undefined
      ? {}
      : { columns: value.columns as RelationalColumnsRuntime }),
    ...(value.with === undefined
      ? {}
      : { with: value.with as Record<string, unknown> }),
    ...(value.where === undefined ? {} : { where: value.where as Condition }),
    ...(value.orderBy === undefined ? {} : { orderBy: value.orderBy }),
    ...(value.limit === undefined ? {} : { limit: value.limit as number }),
    ...(value.offset === undefined ? {} : { offset: value.offset as number }),
  };
}

function normalizeRelationalOrderBy(
  orderBy: unknown | readonly unknown[] | undefined,
): unknown[] {
  if (orderBy === undefined) {
    return [];
  }
  return Array.isArray(orderBy) ? [...orderBy] : [orderBy];
}

function pickRow(
  row: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    picked[key] = row[key];
  }
  return picked;
}

function valuesForKeys(
  row: Record<string, unknown>,
  keys: readonly string[],
): readonly unknown[] {
  return keys.map((key) => row[key]);
}

function uniqueRelationKeys(
  keys: readonly (readonly unknown[])[],
): Array<readonly unknown[]> {
  const seen = new Set<string>();
  const unique: Array<readonly unknown[]> = [];

  for (const values of keys) {
    if (hasNullishValue(values)) {
      continue;
    }

    const key = relationKey(values);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(values);
    }
  }

  return unique;
}

function relationKey(values: readonly unknown[]): string {
  return JSON.stringify(values.map(stableRelationKeyValue));
}

function stableRelationKeyValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Uint8Array) {
    return [...value];
  }
  return value;
}

function hasNullishValue(values: readonly unknown[]): boolean {
  return values.some((value) => value === null || value === undefined);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function findTableColumnByName(
  table: TableDefinition,
  name: string,
): TableColumn<TableDefinition> | undefined {
  return Object.values(table.columns).find((column) => column.name === name);
}

function columnPropertyName(column: TableColumn<TableDefinition>): string {
  if (typeof column.propertyName !== "string") {
    throw new OrmError("Relation column is missing property metadata", {
      code: "ORM_INVALID_COLUMN",
      details: { table: column.tableName, column: column.name },
    });
  }
  return column.propertyName;
}

function assertColumnBelongsToTable(
  column: unknown,
  table: TableDefinition,
  role: string,
): asserts column is TableColumn<TableDefinition> {
  if (!isColumn(column) || column.tableName !== table.name) {
    throw new OrmError("Relation column belongs to the wrong table", {
      code: "ORM_INVALID_COLUMN",
      details: { table: table.name, role },
    });
  }
}

function assertRelationDefinition(
  value: unknown,
): asserts value is RelationDefinition {
  if (
    !isRecord(value) || value.kind !== "relation" ||
    (value.mode !== "one" && value.mode !== "many") ||
    !isTable(value.sourceTable) ||
    !isTable(value.targetTable)
  ) {
    throw new OrmError("Expected a relation definition", {
      code: "ORM_INVALID_QUERY",
    });
  }
}

function isTableRelations(value: unknown): value is TableRelations {
  return isRecord(value) && value.kind === "table_relations" &&
    isTable(value.table) && isRecord(value.relations);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value);
}

type SelectJoinKind = "inner" | "left" | "right" | "full";

interface SelectJoin {
  readonly kind: SelectJoinKind;
  readonly table: TableDefinition;
  readonly on: Condition;
}

interface SelectState {
  readonly table?: TableDefinition;
  readonly projection?: SelectProjection;
  readonly distinct?: boolean;
  readonly joins: readonly SelectJoin[];
  readonly condition?: Condition;
  readonly groupBy?: readonly Sql[];
  readonly having?: Condition;
  readonly orderBy?: readonly Sql[];
  readonly limit?: number;
  readonly offset?: number;
}

class SisalSelectBuilder<TTable, TResult>
  implements SelectBuilder<TTable, TResult> {
  readonly #database: Database;
  readonly #state: SelectState;

  constructor(database: Database, state: SelectState) {
    this.#database = database;
    this.#state = state;
  }

  #with(patch: Partial<SelectState>): SelectBuilder<TTable, TResult> {
    return new SisalSelectBuilder<TTable, TResult>(this.#database, {
      ...this.#state,
      ...patch,
    });
  }

  from<TNewTable extends TableDefinition>(
    table: TNewTable,
  ): SelectBuilder<
    TNewTable,
    unknown extends TResult ? InferSelect<TNewTable> : TResult
  > {
    assertTable(table);
    return new SisalSelectBuilder<
      TNewTable,
      unknown extends TResult ? InferSelect<TNewTable> : TResult
    >(this.#database, { ...this.#state, table });
  }

  distinct(): SelectBuilder<TTable, TResult> {
    return this.#with({ distinct: true });
  }

  innerJoin(
    table: TableDefinition,
    on: Condition,
  ): SelectBuilder<TTable, TResult> {
    return this.#join("inner", table, on);
  }

  rightJoin(
    table: TableDefinition,
    on: Condition,
  ): SelectBuilder<TTable, TResult> {
    return this.#join("right", table, on);
  }

  fullJoin(
    table: TableDefinition,
    on: Condition,
  ): SelectBuilder<TTable, TResult> {
    return this.#join("full", table, on);
  }

  groupBy(...columns: unknown[]): SelectBuilder<TTable, TResult> {
    if (columns.length === 0) {
      throw new OrmError("groupBy requires at least one column", {
        code: "ORM_INVALID_QUERY",
      });
    }
    return this.#with({
      groupBy: columns.map((column) =>
        isSql(column) ? column : columnToSql(column)
      ),
    });
  }

  having(condition: Condition): SelectBuilder<TTable, TResult> {
    assertCondition(condition);
    return this.#with({ having: condition });
  }

  leftJoin(
    table: TableDefinition,
    on: Condition,
  ): SelectBuilder<TTable, TResult> {
    return this.#join("left", table, on);
  }

  where(condition: Condition): SelectBuilder<TTable, TResult> {
    assertCondition(condition);
    return this.#with({ condition });
  }

  orderBy(...args: unknown[]): SelectBuilder<TTable, TResult> {
    if (args.length === 0) {
      throw new OrmError("orderBy requires at least one column", {
        code: "ORM_INVALID_QUERY",
      });
    }

    // Legacy form: orderBy(column, "asc" | "desc").
    if (
      args.length === 2 && !isSql(args[0]) &&
      (args[1] === "asc" || args[1] === "desc")
    ) {
      const direction = normalizeOrderDirection(args[1]);
      return this.#with({
        orderBy: [direction === "desc" ? desc(args[0]) : asc(args[0])],
      });
    }

    // Variadic form: asc()/desc() terms, or bare columns (ascending).
    return this.#with({
      orderBy: args.map((arg) => (isSql(arg) ? arg : columnToSql(arg))),
    });
  }

  limit(count: number): SelectBuilder<TTable, TResult> {
    return this.#with({ limit: normalizePositiveInteger(count, "limit") });
  }

  offset(count: number): SelectBuilder<TTable, TResult> {
    return this.#with({ offset: normalizeNonNegativeInteger(count, "offset") });
  }

  toSql(): Sql {
    const {
      table,
      projection,
      distinct,
      joins,
      condition,
      groupBy,
      having,
      orderBy,
      limit,
      offset,
    } = this.#state;

    if (table === undefined) {
      throw new OrmError("Select query requires a table", {
        code: "ORM_INVALID_QUERY",
      });
    }

    const parts: Sql[] = [raw(distinct ? "select distinct " : "select ")];
    parts.push(projection === undefined ? raw("*") : projectionSql(projection));
    parts.push(raw(" from "), identifier(table.name));

    for (const join of joins) {
      assertTable(join.table);
      assertCondition(join.on);
      parts.push(
        raw(` ${join.kind} join `),
        identifier(join.table.name),
        raw(" on "),
        join.on.sql,
      );
    }

    if (condition !== undefined) {
      parts.push(raw(" where "), condition.sql);
    }

    if (groupBy !== undefined && groupBy.length > 0) {
      parts.push(raw(" group by "), joinSql([...groupBy], raw(", ")));
    }

    if (having !== undefined) {
      parts.push(raw(" having "), having.sql);
    }

    if (orderBy !== undefined && orderBy.length > 0) {
      parts.push(raw(" order by "), joinSql([...orderBy], raw(", ")));
    }

    if (limit !== undefined) {
      parts.push(raw(" limit "), paramSql(limit));
    }

    if (offset !== undefined) {
      parts.push(raw(" offset "), paramSql(offset));
    }

    return joinSql(parts, emptySql());
  }

  async execute(): Promise<TResult[]> {
    const result = await this.#database.query<TResult>(this.toSql());
    return result.rows;
  }

  #join(
    kind: SelectJoinKind,
    table: TableDefinition,
    on: Condition,
  ): SelectBuilder<TTable, TResult> {
    assertTable(table);
    assertCondition(on);
    return this.#with({
      joins: [...this.#state.joins, { kind, table, on }],
    });
  }
}

function projectionSql(projection: SelectProjection): Sql {
  const entries = Object.entries(projection);

  if (entries.length === 0) {
    throw new OrmError("Select projection cannot be empty", {
      code: "ORM_INVALID_QUERY",
    });
  }

  return joinSql(
    entries.map(([alias, column]) =>
      sql`${columnToSql(column)} as ${identifier(alias)}`
    ),
    raw(", "),
  );
}

function returningSql(returning: SelectProjection | boolean): Sql | undefined {
  if (returning === false) {
    return undefined;
  }
  if (returning === true) {
    return raw(" returning *");
  }
  return joinSql([raw(" returning "), projectionSql(returning)], emptySql());
}

function toConflictTargets(
  target: unknown | readonly unknown[],
): readonly unknown[] {
  return Array.isArray(target) ? target : [target];
}

function conflictTargetSql(target: unknown): Sql {
  // Conflict targets are unqualified column names, e.g. `on conflict ("id")`.
  if (isColumn(target)) {
    return identifier(target.name);
  }
  if (typeof target === "string") {
    return identifier(target);
  }
  if (isSql(target)) {
    return target;
  }
  throw new OrmError("Invalid conflict target column", {
    code: "ORM_INVALID_QUERY",
  });
}

function conflictSql(
  conflict: InsertConflict | undefined,
  table: TableDefinition,
): Sql | undefined {
  if (conflict === undefined) {
    return undefined;
  }

  const targets = conflict.target ?? [];
  const targetList = targets.length === 0
    ? undefined
    : joinSql([...targets].map(conflictTargetSql), raw(", "));

  if (conflict.kind === "nothing") {
    return targetList === undefined ? raw(" on conflict do nothing") : joinSql(
      [raw(" on conflict ("), targetList, raw(") do nothing")],
      emptySql(),
    );
  }

  const entries = Object.entries(conflict.set)
    .filter(([, value]) => value !== undefined);

  if (entries.length === 0) {
    throw new OrmError("onConflictDoUpdate requires set values", {
      code: "ORM_INVALID_QUERY",
    });
  }

  for (const [name] of entries) {
    assertTableColumn(table, name);
  }

  const setSql = joinSql(
    entries.map(([name, value]) => sql`${identifier(name)} = ${value}`),
  );
  const parts = [
    raw(" on conflict ("),
    targetList!,
    raw(") do update set "),
    setSql,
  ];

  if (conflict.where !== undefined) {
    parts.push(raw(" where "), conflict.where.sql);
  }

  return joinSql(parts, emptySql());
}

type InsertConflict =
  | { readonly kind: "nothing"; readonly target?: readonly unknown[] }
  | {
    readonly kind: "update";
    readonly target: readonly unknown[];
    readonly set: Record<string, unknown>;
    readonly where?: Condition;
  };

class SisalInsertBuilder<TTable extends TableDefinition>
  implements InsertBuilder<TTable> {
  readonly #database: Database;
  readonly #table: TTable;
  readonly #rows?: Array<InferInsert<TTable>>;
  readonly #returning: SelectProjection | boolean;
  readonly #conflict?: InsertConflict;

  constructor(
    database: Database,
    table: TTable,
    rows?: Array<InferInsert<TTable>>,
    returning: SelectProjection | boolean = false,
    conflict?: InsertConflict,
  ) {
    this.#database = database;
    this.#table = table;
    this.#rows = rows;
    this.#returning = returning;
    this.#conflict = conflict;
  }

  values(
    value: InferInsert<TTable> | InferInsert<TTable>[],
  ): InsertBuilder<TTable> {
    const rows = Array.isArray(value) ? value : [value];

    if (rows.length === 0) {
      throw new OrmError("Insert values cannot be empty", {
        code: "ORM_INVALID_QUERY",
      });
    }

    return new SisalInsertBuilder(
      this.#database,
      this.#table,
      rows.map((row) => ({ ...row })),
      this.#returning,
      this.#conflict,
    );
  }

  onConflictDoNothing(
    config: { readonly target?: unknown | readonly unknown[] } = {},
  ): InsertBuilder<TTable> {
    return new SisalInsertBuilder(
      this.#database,
      this.#table,
      this.#rows,
      this.#returning,
      {
        kind: "nothing",
        ...(config.target === undefined
          ? {}
          : { target: toConflictTargets(config.target) }),
      },
    );
  }

  onConflictDoUpdate(
    config: {
      readonly target: unknown | readonly unknown[];
      readonly set: Partial<InferInsert<TTable>>;
      readonly where?: Condition;
    },
  ): InsertBuilder<TTable> {
    const target = toConflictTargets(config.target);
    if (target.length === 0) {
      throw new OrmError("onConflictDoUpdate requires a conflict target", {
        code: "ORM_INVALID_QUERY",
      });
    }
    return new SisalInsertBuilder(
      this.#database,
      this.#table,
      this.#rows,
      this.#returning,
      {
        kind: "update",
        target,
        set: { ...(config.set as Record<string, unknown>) },
        ...(config.where === undefined ? {} : { where: config.where }),
      },
    );
  }

  returning(): InsertBuilder<TTable, InferSelect<TTable>>;
  returning<TProjection extends SelectProjection>(
    projection: TProjection,
  ): InsertBuilder<TTable, InferProjection<TProjection>>;
  returning(
    projection?: SelectProjection,
  ): InsertBuilder<TTable, InferSelect<TTable>> {
    return new SisalInsertBuilder(
      this.#database,
      this.#table,
      this.#rows,
      projection ?? true,
      this.#conflict,
    ) as unknown as InsertBuilder<TTable, InferSelect<TTable>>;
  }

  toSql(): Sql {
    if (this.#rows === undefined || this.#rows.length === 0) {
      throw new OrmError("Insert query requires values", {
        code: "ORM_INVALID_QUERY",
      });
    }

    const columnNames = getInsertColumnNames(this.#table, this.#rows);

    if (columnNames.length === 0) {
      throw new OrmError("Insert query has no columns", {
        code: "ORM_INVALID_QUERY",
      });
    }

    const columnSql = joinSql(columnNames.map((name) => identifier(name)));
    const valuesSql = joinSql(
      this.#rows.map((row) =>
        sql`(${
          joinSql(
            columnNames.map((name) =>
              paramSql((row as Record<string, unknown>)[name])
            ),
          )
        })`
      ),
    );
    const parts = [
      raw("insert into "),
      identifier(this.#table.name),
      raw(" ("),
      columnSql,
      raw(") values "),
      valuesSql,
    ];

    const conflict = conflictSql(this.#conflict, this.#table);
    if (conflict !== undefined) {
      parts.push(conflict);
    }

    const returning = returningSql(this.#returning);
    if (returning !== undefined) {
      parts.push(returning);
    }

    return joinSql(parts, emptySql());
  }

  execute(): Promise<OrmQueryResult<InferSelect<TTable>>> {
    return this.#database.execute<InferSelect<TTable>>(this.toSql());
  }
}

class SisalUpdateBuilder<TTable extends TableDefinition>
  implements UpdateBuilder<TTable> {
  readonly #database: Database;
  readonly #table: TTable;
  readonly #values?: Partial<InferInsert<TTable>>;
  readonly #condition?: Condition;
  readonly #allowAllRows: boolean;
  readonly #returning: SelectProjection | boolean;

  constructor(
    database: Database,
    table: TTable,
    values?: Partial<InferInsert<TTable>>,
    condition?: Condition,
    allowAllRows = false,
    returning: SelectProjection | boolean = false,
  ) {
    this.#database = database;
    this.#table = table;
    this.#values = values;
    this.#condition = condition;
    this.#allowAllRows = allowAllRows;
    this.#returning = returning;
  }

  set(values: Partial<InferInsert<TTable>>): UpdateBuilder<TTable> {
    return new SisalUpdateBuilder(
      this.#database,
      this.#table,
      { ...values },
      this.#condition,
      this.#allowAllRows,
      this.#returning,
    );
  }

  where(condition: Condition): UpdateBuilder<TTable> {
    assertCondition(condition);
    return new SisalUpdateBuilder(
      this.#database,
      this.#table,
      this.#values,
      condition,
      this.#allowAllRows,
      this.#returning,
    );
  }

  unsafeAllowAllRows(): UpdateBuilder<TTable> {
    return new SisalUpdateBuilder(
      this.#database,
      this.#table,
      this.#values,
      this.#condition,
      true,
      this.#returning,
    );
  }

  returning(): UpdateBuilder<TTable, InferSelect<TTable>>;
  returning<TProjection extends SelectProjection>(
    projection: TProjection,
  ): UpdateBuilder<TTable, InferProjection<TProjection>>;
  returning(
    projection?: SelectProjection,
  ): UpdateBuilder<TTable, InferSelect<TTable>> {
    return new SisalUpdateBuilder(
      this.#database,
      this.#table,
      this.#values,
      this.#condition,
      this.#allowAllRows,
      projection ?? true,
    ) as unknown as UpdateBuilder<TTable, InferSelect<TTable>>;
  }

  toSql(): Sql {
    if (this.#values === undefined) {
      throw new OrmError("Update query requires set values", {
        code: "ORM_INVALID_QUERY",
      });
    }

    const entries = getDefinedEntries(this.#table, this.#values);
    appendOnUpdateEntries(this.#table, entries);

    if (entries.length === 0) {
      throw new OrmError("Update query has no set values", {
        code: "ORM_INVALID_QUERY",
      });
    }

    const setSql = joinSql(
      entries.map(([name, value]) => sql`${identifier(name)} = ${value}`),
    );
    const parts = [
      raw("update "),
      identifier(this.#table.name),
      raw(" set "),
      setSql,
    ];

    if (this.#condition === undefined) {
      assertUnsafeAllRowsAllowed(
        "update",
        this.#allowAllRows,
        this.#table.name,
      );
    } else {
      parts.push(raw(" where "), this.#condition.sql);
    }

    const returning = returningSql(this.#returning);
    if (returning !== undefined) {
      parts.push(returning);
    }

    return joinSql(parts, emptySql());
  }

  execute(): Promise<OrmQueryResult<InferSelect<TTable>>> {
    return this.#database.execute<InferSelect<TTable>>(this.toSql());
  }
}

class SisalDeleteBuilder<TTable extends TableDefinition>
  implements DeleteBuilder<TTable> {
  readonly #database: Database;
  readonly #table: TTable;
  readonly #condition?: Condition;
  readonly #allowAllRows: boolean;
  readonly #returning: SelectProjection | boolean;

  constructor(
    database: Database,
    table: TTable,
    condition?: Condition,
    allowAllRows = false,
    returning: SelectProjection | boolean = false,
  ) {
    this.#database = database;
    this.#table = table;
    this.#condition = condition;
    this.#allowAllRows = allowAllRows;
    this.#returning = returning;
  }

  where(condition: Condition): DeleteBuilder<TTable> {
    assertCondition(condition);
    return new SisalDeleteBuilder(
      this.#database,
      this.#table,
      condition,
      this.#allowAllRows,
      this.#returning,
    );
  }

  unsafeAllowAllRows(): DeleteBuilder<TTable> {
    return new SisalDeleteBuilder(
      this.#database,
      this.#table,
      this.#condition,
      true,
      this.#returning,
    );
  }

  returning(): DeleteBuilder<TTable, InferSelect<TTable>>;
  returning<TProjection extends SelectProjection>(
    projection: TProjection,
  ): DeleteBuilder<TTable, InferProjection<TProjection>>;
  returning(
    projection?: SelectProjection,
  ): DeleteBuilder<TTable, InferSelect<TTable>> {
    return new SisalDeleteBuilder(
      this.#database,
      this.#table,
      this.#condition,
      this.#allowAllRows,
      projection ?? true,
    ) as unknown as DeleteBuilder<TTable, InferSelect<TTable>>;
  }

  toSql(): Sql {
    const parts = [
      raw("delete from "),
      identifier(this.#table.name),
    ];

    if (this.#condition === undefined) {
      assertUnsafeAllRowsAllowed(
        "delete",
        this.#allowAllRows,
        this.#table.name,
      );
    } else {
      parts.push(raw(" where "), this.#condition.sql);
    }

    const returning = returningSql(this.#returning);
    if (returning !== undefined) {
      parts.push(returning);
    }

    return joinSql(parts, emptySql());
  }

  execute(): Promise<OrmQueryResult<InferSelect<TTable>>> {
    return this.#database.execute<InferSelect<TTable>>(this.toSql());
  }
}

interface ColumnTypeExtra {
  readonly length?: number;
  readonly precision?: number;
  readonly scale?: number;
}

function createColumnBuilder<T>(
  dataType: ColumnDataType,
  extra: ColumnTypeExtra = {},
): ColumnBuilder<T | null> {
  return new SisalColumnBuilder<T | null, false, false>(
    {
      dataType,
      ...(extra.length === undefined ? {} : { length: extra.length }),
      ...(extra.precision === undefined ? {} : { precision: extra.precision }),
      ...(extra.scale === undefined ? {} : { scale: extra.scale }),
      nullable: true,
      hasDefault: false,
      primaryKey: false,
      unique: false,
    },
    false,
    false,
  );
}

// Serial/bigserial are DB-generated, so they are optional on insert (THasDefault)
// without emitting a SQL DEFAULT clause.
function createSerialBuilder<T>(
  dataType: ColumnDataType,
): ColumnBuilder<T | null, false, true> {
  return new SisalColumnBuilder<T | null, false, true>(
    {
      dataType,
      nullable: true,
      hasDefault: false,
      primaryKey: false,
      unique: false,
    },
    false,
    true,
  );
}

function numericExtra(
  precision?: number,
  scale?: number,
): ColumnTypeExtra {
  return {
    ...(precision === undefined ? {} : { precision }),
    ...(scale === undefined ? {} : { scale }),
  };
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
    }));

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
    ...(primaryKeyColumns.length === 0
      ? {}
      : { primaryKey: { columns: primaryKeyColumns } }),
    uniqueConstraints,
    foreignKeys,
    indexes: [],
    checks: [],
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

function cloneColumnDefinition<T>(
  definition: ColumnDefinition<T>,
): ColumnDefinition<T> {
  return {
    ...(definition.name === undefined ? {} : { name: definition.name }),
    dataType: definition.dataType,
    ...(definition.length === undefined ? {} : { length: definition.length }),
    ...(definition.precision === undefined
      ? {}
      : { precision: definition.precision }),
    ...(definition.scale === undefined ? {} : { scale: definition.scale }),
    ...(definition.array === undefined ? {} : { array: definition.array }),
    nullable: definition.nullable,
    hasDefault: definition.hasDefault,
    primaryKey: definition.primaryKey,
    unique: definition.unique,
    ...(definition.references === undefined ? {} : {
      references: {
        table: definition.references.table,
        column: definition.references.column,
      },
    }),
    ...(definition.defaultValue === undefined
      ? {}
      : { defaultValue: definition.defaultValue }),
    ...(definition.onUpdate === undefined
      ? {}
      : { onUpdate: definition.onUpdate }),
  };
}

function isColumnBuilder(value: unknown): value is ColumnBuilder<unknown> {
  return isRecord(value) && isRecord(value.definition) &&
    typeof value.named === "function" &&
    typeof value.notNull === "function";
}

function makeSql(chunks: SqlChunk[]): Sql {
  return Object.freeze({
    kind: "sql",
    chunks: Object.freeze([...chunks]),
  });
}

function paramSql(value: unknown): Sql {
  return makeSql([{ kind: "param", value: serializeSqlValue(value) }]);
}

interface RenderState {
  text: string;
  params: SqlParameter[];
  dialect: SqlDialect;
}

function renderSqlInto(query: Sql, state: RenderState): void {
  for (const chunk of query.chunks) {
    if (chunk.kind === "text" || chunk.kind === "raw") {
      state.text += chunk.value;
      continue;
    }

    if (chunk.kind === "identifier") {
      state.text += quoteIdentifier(chunk.value, state.dialect);
      continue;
    }

    if (chunk.kind === "param") {
      state.params.push(chunk.value);
      state.text += state.dialect === "postgres"
        ? `$${state.params.length}`
        : "?";
      continue;
    }

    renderSqlInto(chunk.value, state);
  }
}

function binaryCondition(
  column: unknown,
  operator: string,
  value: unknown,
): Condition {
  // A column value renders as a column reference (e.g. join `ON a.x = b.y`);
  // anything else is bound as a parameter.
  const right = isColumn(value) ? columnToSql(value) : value;
  return createCondition(sql`${columnToSql(column)} ${raw(operator)} ${right}`);
}

function betweenCondition(
  column: unknown,
  min: unknown,
  max: unknown,
  negated: boolean,
): Condition {
  // Bounds render as column references when given columns, else bound params.
  const lower = isColumn(min) ? columnToSql(min) : min;
  const upper = isColumn(max) ? columnToSql(max) : max;
  return createCondition(
    sql`${columnToSql(column)} ${
      raw(negated ? "not between" : "between")
    } ${lower} and ${upper}`,
  );
}

function inArrayCondition(
  column: unknown,
  values: readonly unknown[],
  negated: boolean,
): Condition {
  if (!Array.isArray(values)) {
    throw new OrmError("inArray requires an array of values", {
      code: "ORM_INVALID_QUERY",
    });
  }

  if (values.length === 0) {
    return createCondition(raw(negated ? "1 = 1" : "1 = 0"));
  }

  const list = joinSql(
    values.map((value) => sql`${value}`),
    raw(", "),
  );

  return createCondition(
    sql`${columnToSql(column)} ${raw(negated ? "not in" : "in")} (${list})`,
  );
}

function createCondition(conditionSql: Sql): Condition {
  return Object.freeze({
    kind: "condition",
    sql: conditionSql,
  });
}

function combineConditions(
  operator: "and" | "or",
  conditions: Array<Condition | null | undefined>,
): Condition {
  const validConditions = conditions.filter((
    condition,
  ): condition is Condition => condition !== undefined && condition !== null);

  if (validConditions.length === 0) {
    throw new OrmError("At least one condition is required", {
      code: "ORM_INVALID_QUERY",
      details: { operator },
    });
  }

  if (validConditions.length === 1) {
    return validConditions[0];
  }

  return createCondition(
    joinSql(
      validConditions.map((condition) => sql`(${condition.sql})`),
      raw(` ${operator} `),
    ),
  );
}

function assertCondition(value: Condition): void {
  if (!isCondition(value)) {
    throw new OrmError("Expected a condition", {
      code: "ORM_INVALID_QUERY",
    });
  }
}

function isCondition(value: unknown): value is Condition {
  return isRecord(value) && value.kind === "condition" && isSql(value.sql);
}

function columnToSql(column: unknown): Sql {
  if (isSql(column)) {
    return column;
  }

  if (isColumn(column)) {
    return identifier(`${column.tableName}.${column.name}`);
  }

  if (typeof column === "string") {
    return identifier(column);
  }

  throw new OrmError("Expected a SQL column", {
    code: "ORM_INVALID_COLUMN",
  });
}

function assertTable(value: unknown): asserts value is TableDefinition {
  if (!isTable(value)) {
    throw new OrmError("Expected a table definition", {
      code: "ORM_INVALID_TABLE",
    });
  }
}

function getInsertColumnNames<TTable extends TableDefinition>(
  table: TTable,
  rows: Array<InferInsert<TTable>>,
): string[] {
  const names = new Set<string>();

  for (const row of rows) {
    for (const key of Object.keys(row as Record<string, unknown>)) {
      if ((row as Record<string, unknown>)[key] !== undefined) {
        assertTableColumn(table, key);
        names.add(key);
      }
    }
  }

  return [...names];
}

function getDefinedEntries<TTable extends TableDefinition>(
  table: TTable,
  values: Partial<InferInsert<TTable>>,
): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [];

  for (
    const [key, value] of Object.entries(values as Record<string, unknown>)
  ) {
    if (value === undefined) {
      continue;
    }

    assertTableColumn(table, key);
    entries.push([key, value]);
  }

  return entries;
}

// Appends `column = fn()` for every `.$onUpdate()` column not already set.
function appendOnUpdateEntries(
  table: TableDefinition,
  entries: Array<[string, unknown]>,
): void {
  const present = new Set(entries.map(([key]) => key));

  for (const [propertyName, column] of Object.entries(table.columns)) {
    const onUpdate = (column as { readonly onUpdate?: () => unknown }).onUpdate;
    if (onUpdate !== undefined && !present.has(propertyName)) {
      entries.push([propertyName, onUpdate()]);
    }
  }
}

function assertTableColumn(table: TableDefinition, key: string): void {
  if (!Object.hasOwn(table.columns, key)) {
    throw new OrmError("Unknown table column", {
      code: "ORM_INVALID_COLUMN",
      details: { table: table.name, column: key },
    });
  }
}

function assertUnsafeAllRowsAllowed(
  operation: "update" | "delete",
  allowed: boolean,
  table: string,
): void {
  if (allowed) {
    return;
  }

  throw new OrmError(
    `Refusing to ${operation} all rows without an explicit unsafeAllowAllRows() call`,
    {
      code: "ORM_INVALID_QUERY",
      details: { operation, table },
    },
  );
}

function normalizeOrderDirection(direction: "asc" | "desc"): "asc" | "desc" {
  if (direction !== "asc" && direction !== "desc") {
    throw new OrmError("Invalid order direction", {
      code: "ORM_INVALID_QUERY",
      details: { direction },
    });
  }

  return direction;
}

function normalizePositiveInteger(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new OrmError(`${field} must be greater than zero`, {
      code: "ORM_INVALID_QUERY",
      details: { field },
    });
  }

  return Math.floor(value);
}

function normalizeNonNegativeInteger(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new OrmError(`${field} must be zero or greater`, {
      code: "ORM_INVALID_QUERY",
      details: { field },
    });
  }

  return Math.floor(value);
}

function validateIdentifierPath(
  name: string,
  code: OrmErrorCode,
): string {
  if (typeof name !== "string") {
    throw new OrmError("Identifier must be a string", { code });
  }

  const normalized = name.trim();

  if (
    normalized.length === 0 ||
    normalized.startsWith(".") ||
    normalized.endsWith(".") ||
    normalized.includes("..") ||
    hasControlCharacter(normalized) ||
    normalized.includes('"') ||
    normalized.includes("`")
  ) {
    throw new OrmError("Identifier is invalid", {
      code,
      details: { name },
    });
  }

  for (const part of normalized.split(".")) {
    if (!isValidIdentifierPart(part)) {
      throw new OrmError("Identifier is invalid", {
        code,
        details: { name },
      });
    }
  }

  return normalized;
}

function isValidIdentifierPart(value: string): boolean {
  return /^[A-Za-z0-9_]+$/.test(value);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code <= 31 || code === 127) {
      return true;
    }
  }

  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cloneSqlQuery(query: SqlQuery): SqlQuery {
  return {
    text: query.text,
    params: [...query.params],
  };
}

function transactionToDriver(transaction: OrmTransaction): OrmDriver {
  return {
    query<T = unknown>(query: SqlQuery): Promise<OrmQueryResult<T>> {
      return transaction.query<T>(query);
    },

    execute(query: SqlQuery): Promise<OrmQueryResult> {
      return transaction.execute(query);
    },
  };
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt);
}

// Examples:
//
// const users = defineTable("users", {
//   id: columns.text().primaryKey(),
//   name: columns.text().notNull(),
//   email: columns.text().notNull().unique(),
//   age: columns.integer().optional(),
//   createdAt: columns.timestamp().default(() => new Date()),
// });
//
// type User = InferSelect<typeof users>;
// type NewUser = InferInsert<typeof users>;
//
// const db = createDatabase({
//   driver: noopOrmDriver(),
// });
//
// const rows = await db
//   .select()
//   .from(users)
//   .where(eq(users.columns.id, "u_123"))
//   .limit(1)
//   .execute();
//
// await db.insert(users).values({
//   id: "u_123",
//   name: "Lucas",
//   email: "lucas@example.com",
//   createdAt: new Date(),
// }).execute();
//
// await db.update(users)
//   .set({ name: "Lucas Vieira" })
//   .where(eq(users.columns.id, "u_123"))
//   .execute();
//
// await db.delete(users)
//   .where(eq(users.columns.id, "u_123"))
//   .execute();
//
// await db.execute(sql`
//   select *
//   from users
//   where id = ${"u_123"}
// `);
//
// await db.transaction(async (tx) => {
//   await tx.insert(users).values({
//     id: "u_456",
//     name: "Ana",
//     email: "ana@example.com",
//     createdAt: new Date(),
//   }).execute();
// });
