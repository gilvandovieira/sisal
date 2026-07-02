/**
 * Relation definitions (`relations()`) and the relational query runtime
 * behind `db.query.<table>.findMany/findFirst`.
 *
 * Part of the `@sisal/orm` core; re-exported through `./mod.ts`.
 */

import {
  and,
  type AnyTableDefinition,
  type Condition,
  eq,
  inArray,
  type InferSelect,
  isColumn,
  isTable,
  or,
  OrmError,
  raw,
  type SelectProjection,
  type SelectProjectionValue,
  type TableColumn,
  type TableDefinition,
} from "@sisal/core";
import {
  assertTable,
  assertTableColumn,
  isRecord,
  isTemporalSqlValue,
  serializeTemporalValue,
} from "@sisal/core/unstable-internal";
import type {
  Database,
  DatabaseQuery,
  DatabaseSchema,
  RawQueryExecutor,
} from "./database.ts";

/** Relational metadata list accepted by {@link createDatabase}. */
export type RelationsList = readonly TableRelations[];

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
  // deno-lint-ignore no-explicit-any -- Relation maps need to preserve any source/target table pair.
  RelationDefinition<any, any>
>;

/** Rebinds each relation in a config map to carry its own key as the relation name. */
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

/** Looks up the relation map declared for a table within a relations list. */
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

/** The keys of a column selection explicitly set to `true`. */
type TrueSelectionKeys<TSelection> = {
  [K in keyof TSelection]: TSelection[K] extends true ? K : never;
}[keyof TSelection];

/** The keys of a column selection explicitly set to `false`. */
type FalseSelectionKeys<TSelection> = {
  [K in keyof TSelection]: TSelection[K] extends false ? K : never;
}[keyof TSelection];

/** Narrows a set of keys to those that are real selectable columns of a table. */
type SelectableKeys<TTable, TKeys> = TTable extends TableDefinition
  ? Extract<TKeys, keyof InferSelect<TTable>>
  : never;

/** The row shape a relational query returns for its `columns` selection (all / include / exclude). */
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

/** The target table definition a relation points at, defaulting to any table. */
type RelationTarget<TValue> = TValue extends
  { readonly targetTable: infer TTarget }
  ? TTarget extends TableDefinition ? TTarget : AnyTableDefinition
  : AnyTableDefinition;

/** Normalizes a `with` entry to its nested config object, dropping booleans/nullish. */
type RelationConfigValue<TValue> = [TValue] extends [never]
  ? Record<never, never>
  : TValue extends true | false | null | undefined ? Record<never, never>
  : TValue;

/** Partial fallback shape for a related row when no nested selection is given. */
type RelationObjectFallback<TRelation> = Partial<
  InferSelect<RelationTarget<TRelation>>
>;

/** The attached value of one relation — an array for `many`, a nullable object for `one`. */
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

/** The combined shape of every relation loaded through a query's `with` clause. */
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

export interface RelationRegistry {
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

export function createDatabaseQuery<
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

export function createRelationRegistry(
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
  if (isTemporalSqlValue(value)) {
    return serializeTemporalValue(value);
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
