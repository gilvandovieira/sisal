/**
 * Immutable query builders (select/insert/update/delete, compound selects,
 * CTEs, derived-table subqueries) and prepared queries.
 *
 * Part of the `@sisal/orm` core; re-exported through `./mod.ts`.
 */

import type { Database, OrmQueryResult } from "./database.ts";
import { OrmError } from "./errors.ts";
import { asc, desc } from "./operators.ts";
import {
  assertCondition,
  columnToSql,
  type Condition,
  emptySql,
  fillPreparedPlan,
  identifier,
  type InferProjection,
  isColumn,
  isSql,
  joinSql,
  paramSql,
  type PlaceholderValues,
  type PreparedPlan,
  QUERY_BUILDER_BRAND,
  raw,
  renderToPlan,
  type SelectColumnRef,
  type SelectProjection,
  type Sql,
  sql,
  type SqlQuery,
} from "./sql.ts";
import {
  assertTable,
  assertTableColumn,
  type InferInsert,
  type InferSelect,
  type TableDefinition,
} from "./table.ts";

/** A `from(...)` argument: a table, a CTE, or a subquery derived table. */
type SelectFromSource = TableDefinition | Record<string, SelectColumnRef>;

/**
 * Result of `from(source)`: a table seeds the row type from its columns, while a
 * CTE/subquery keeps the current projection type.
 */
type SelectFromResult<TSource extends SelectFromSource, TResult> =
  TSource extends TableDefinition ? SelectBuilder<
      TSource,
      unknown extends TResult ? InferSelect<TSource> : TResult
    >
    : SelectBuilder<unknown, TResult>;

/** Fluent builder for `SELECT` queries. */
export interface SelectBuilder<TTable, TResult> {
  /**
   * Selects from a table, common table expression ({@link Database.with}), or
   * subquery aliased as a derived table via {@link SelectBuilder.as}.
   */
  from<TSource extends SelectFromSource>(
    source: TSource,
  ): SelectFromResult<TSource, TResult>;

  /** Emits `SELECT DISTINCT`. */
  distinct(): SelectBuilder<TTable, TResult>;

  /** Postgres `SELECT DISTINCT ON (...)`: keeps the first row per expression. */
  distinctOn(...columns: unknown[]): SelectBuilder<TTable, TResult>;

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

  /**
   * Row-level locking (`FOR UPDATE` / `FOR SHARE`) — Postgres/MySQL only.
   * Pass `{ skipLocked }` or `{ noWait }` to control contention and `{ of }` to
   * lock only specific tables. SQLite has no locking clause.
   */
  for(
    strength: "update" | "share",
    options?: ForLockOptions,
  ): SelectBuilder<TTable, TResult>;

  /**
   * Aliases this query as a derived table for `.from(...)`, exposing its
   * projected columns as references (e.g. `const t = sub.as("t"); t.id`).
   */
  as(
    alias: string,
  ): Subquery<{ readonly [K in keyof TResult]-?: SelectColumnRef }>;

  /** `UNION` with another query (duplicate rows removed). */
  union(other: SetOperand<TResult>): CompoundSelectBuilder<TResult>;
  /** `UNION ALL` with another query (duplicate rows kept). */
  unionAll(other: SetOperand<TResult>): CompoundSelectBuilder<TResult>;
  /** `INTERSECT` with another query (rows present in both). */
  intersect(other: SetOperand<TResult>): CompoundSelectBuilder<TResult>;
  /** `INTERSECT ALL` with another query (keeps duplicates). */
  intersectAll(other: SetOperand<TResult>): CompoundSelectBuilder<TResult>;
  /** `EXCEPT` with another query (rows in this but not the other). */
  except(other: SetOperand<TResult>): CompoundSelectBuilder<TResult>;
  /** `EXCEPT ALL` with another query (keeps duplicates). */
  exceptAll(other: SetOperand<TResult>): CompoundSelectBuilder<TResult>;

  toSql(): Sql;

  /** Renders once into a {@link PreparedQuery} run later with placeholders. */
  prepare(name?: string): PreparedQuery<TResult[]>;

  execute(): Promise<TResult[]>;
}

/**
 * A query usable as the right-hand operand of a set operation (`union`,
 * `intersect`, `except`). Both {@link SelectBuilder} and
 * {@link CompoundSelectBuilder} satisfy this shape.
 */
export type SetOperand<TResult> = {
  toSql(): Sql;
  execute(): Promise<TResult[]>;
};

/**
 * A combined query produced by a set operation. Trailing `orderBy`/`limit`/
 * `offset` apply to the whole compound, and further set operations may be
 * chained.
 */
export interface CompoundSelectBuilder<TResult> {
  /** `UNION` with another query. */
  union(other: SetOperand<TResult>): CompoundSelectBuilder<TResult>;
  /** `UNION ALL` with another query. */
  unionAll(other: SetOperand<TResult>): CompoundSelectBuilder<TResult>;
  /** `INTERSECT` with another query. */
  intersect(other: SetOperand<TResult>): CompoundSelectBuilder<TResult>;
  /** `INTERSECT ALL` with another query. */
  intersectAll(other: SetOperand<TResult>): CompoundSelectBuilder<TResult>;
  /** `EXCEPT` with another query. */
  except(other: SetOperand<TResult>): CompoundSelectBuilder<TResult>;
  /** `EXCEPT ALL` with another query. */
  exceptAll(other: SetOperand<TResult>): CompoundSelectBuilder<TResult>;
  /** Orders the whole compound by one or more `asc()`/`desc()` terms. */
  orderBy(...terms: unknown[]): CompoundSelectBuilder<TResult>;
  /** Limits the whole compound. */
  limit(count: number): CompoundSelectBuilder<TResult>;
  /** Offsets the whole compound. */
  offset(count: number): CompoundSelectBuilder<TResult>;

  /** Aliases the compound as a derived table for `.from(...)`. */
  as(
    alias: string,
  ): Subquery<{ readonly [K in keyof TResult]-?: SelectColumnRef }>;

  toSql(): Sql;

  /** Renders once into a {@link PreparedQuery} run later with placeholders. */
  prepare(name?: string): PreparedQuery<TResult[]>;

  execute(): Promise<TResult[]>;
}

/**
 * A named common table expression. Its keys are the projected columns of the
 * inner query, each usable as a column reference in `select`, `where`, etc.
 * Create one with {@link Database.$with} and reference it via
 * {@link Database.with}.
 */
export type Cte<
  TColumns extends Record<string, SelectColumnRef> = Record<
    string,
    SelectColumnRef
  >,
> = TColumns;

/**
 * A query aliased as a derived table via {@link SelectBuilder.as}. Its keys are
 * the inner query's projected columns, each usable as a reference once the
 * subquery is passed to `.from(...)`.
 */
export type Subquery<
  TColumns extends Record<string, SelectColumnRef> = Record<
    string,
    SelectColumnRef
  >,
> = TColumns;

/** Options for {@link SelectBuilder.for} row-level locking. */
export interface ForLockOptions {
  /** Restricts the lock to specific tables (`FOR UPDATE OF t1, t2`). */
  readonly of?: TableDefinition | readonly TableDefinition[];
  /** Skips rows already locked by another transaction (`SKIP LOCKED`). */
  readonly skipLocked?: boolean;
  /** Fails immediately instead of waiting on a locked row (`NOWAIT`). */
  readonly noWait?: boolean;
}

/** Intermediate returned by {@link Database.$with}; complete it with `.as`. */
export interface CteBuilder {
  /** Binds the CTE to a query, inferring its columns from the query's projection. */
  as<TResult>(
    query: SetOperand<TResult>,
  ): Cte<{ readonly [K in keyof TResult]-?: SelectColumnRef }>;
}

/** Query root seeded with CTEs, returned by {@link Database.with}. */
export interface WithQueryBuilder {
  select(): SelectBuilder<unknown, unknown>;
  select<TProjection extends SelectProjection>(
    projection: TProjection,
  ): SelectBuilder<unknown, InferProjection<TProjection>>;
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

  /** Renders once into a {@link PreparedQuery} run later with placeholders. */
  prepare(name?: string): PreparedQuery<OrmQueryResult<TReturn>>;

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

  /** Renders once into a {@link PreparedQuery} run later with placeholders. */
  prepare(name?: string): PreparedQuery<OrmQueryResult<TReturn>>;

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

  /** Renders once into a {@link PreparedQuery} run later with placeholders. */
  prepare(name?: string): PreparedQuery<OrmQueryResult<TReturn>>;

  execute(): Promise<OrmQueryResult<TReturn>>;
}

/**
 * A query rendered once that is executed many times with different
 * {@link placeholder} values bound in.
 *
 * Create one with a builder's `prepare(name?)`. Because Sisal is driverless,
 * `prepare` renders the SQL text and its parameter layout a single time; each
 * `execute` only binds fresh values into that layout instead of rebuilding and
 * re-rendering the query. Mirrors Drizzle's `query.prepare(name)`.
 */
export interface PreparedQuery<TExecuteResult = unknown> {
  /** The name passed to `prepare`, if any (parity/diagnostic metadata). */
  readonly name?: string;
  /** Binds placeholder values, returning the driver-ready text + params. */
  toSql(values?: PlaceholderValues): SqlQuery;
  /** Binds placeholder values and runs the query. */
  execute(values?: PlaceholderValues): Promise<TExecuteResult>;
}

type SelectJoinKind = "inner" | "left" | "right" | "full";

interface SelectJoin {
  readonly kind: SelectJoinKind;
  readonly table: TableDefinition;
  readonly on: Condition;
}

interface SelectState {
  readonly table?: TableDefinition;
  readonly fromCte?: string;
  readonly fromSubquery?: SubqueryDefinition;
  readonly ctes?: readonly CteDefinition[];
  readonly projection?: SelectProjection;
  readonly distinct?: boolean;
  readonly distinctOn?: readonly Sql[];
  readonly joins: readonly SelectJoin[];
  readonly condition?: Condition;
  readonly groupBy?: readonly Sql[];
  readonly having?: Condition;
  readonly orderBy?: readonly Sql[];
  readonly limit?: number;
  readonly offset?: number;
  readonly forLock?: ForLockState;
}

/** Internal: a `FOR UPDATE`/`FOR SHARE` clause resolved from {@link ForLockOptions}. */
interface ForLockState {
  readonly strength: "update" | "share";
  readonly of?: readonly TableDefinition[];
  readonly mode?: "skip locked" | "nowait";
}

/** Internal definition behind a {@link Subquery}: its alias and rendered query. */
interface SubqueryDefinition {
  readonly alias: string;
  readonly query: Sql;
}

/** Internal definition behind a {@link Cte}: its name and rendered query. */
interface CteDefinition {
  readonly name: string;
  readonly query: Sql;
}

/** The set operations Sisal can compound two queries with. */
type SetOperationKind =
  | "union"
  | "union all"
  | "intersect"
  | "intersect all"
  | "except"
  | "except all";

// CTE column maps carry their definition out-of-band so the map's own keys stay
// the projected column names (and nothing collides with a real column).
export const CTE_DEFINITIONS = new WeakMap<object, CteDefinition>();

function isCte(value: unknown): value is Record<string, SelectColumnRef> {
  return typeof value === "object" && value !== null &&
    CTE_DEFINITIONS.has(value);
}

// Derived-table (subquery) column maps carry their alias + SQL out-of-band, the
// same way CTEs do, so the map's keys stay the projected column names.
const SUBQUERY_DEFINITIONS = new WeakMap<object, SubqueryDefinition>();

function isSubquery(value: unknown): value is Record<string, SelectColumnRef> {
  return typeof value === "object" && value !== null &&
    SUBQUERY_DEFINITIONS.has(value);
}

// Builds the column-reference map for a subquery aliased via `.as(alias)`.
function makeSubqueryColumns(
  alias: string,
  keys: readonly string[],
  query: Sql,
): Record<string, SelectColumnRef> {
  const columns: Record<string, SelectColumnRef> = {};
  for (const key of keys) {
    columns[key] = {
      name: key,
      tableName: alias,
      dataType: "unknown",
    } as unknown as SelectColumnRef;
  }
  SUBQUERY_DEFINITIONS.set(columns, { alias, query });
  return columns;
}

function withPrefixSql(ctes: readonly CteDefinition[]): Sql {
  return joinSql([
    raw("with "),
    joinSql(
      ctes.map((cte) =>
        joinSql(
          [identifier(cte.name), raw(" as ("), cte.query, raw(")")],
          emptySql(),
        )
      ),
      raw(", "),
    ),
    raw(" "),
  ], emptySql());
}

export function cteColumnKeys(query: SetOperand<unknown>): readonly string[] {
  if (query instanceof SisalSelectBuilder) {
    return query.projectionKeys() ?? [];
  }
  if (query instanceof SisalCompoundSelectBuilder) {
    return query.projectionKeys() ?? [];
  }
  return [];
}

export class SisalSelectBuilder<TTable, TResult>
  implements SelectBuilder<TTable, TResult> {
  readonly [QUERY_BUILDER_BRAND] = true;
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

  from<TSource extends SelectFromSource>(
    source: TSource,
  ): SelectFromResult<TSource, TResult> {
    if (isSubquery(source)) {
      const definition = SUBQUERY_DEFINITIONS.get(source)!;
      return new SisalSelectBuilder(this.#database, {
        ...this.#state,
        table: undefined,
        fromCte: undefined,
        fromSubquery: definition,
      }) as unknown as SelectFromResult<TSource, TResult>;
    }
    if (isCte(source)) {
      const definition = CTE_DEFINITIONS.get(source)!;
      return new SisalSelectBuilder(this.#database, {
        ...this.#state,
        table: undefined,
        fromSubquery: undefined,
        fromCte: definition.name,
      }) as unknown as SelectFromResult<TSource, TResult>;
    }
    assertTable(source);
    return new SisalSelectBuilder(this.#database, {
      ...this.#state,
      table: source,
      fromCte: undefined,
      fromSubquery: undefined,
    }) as unknown as SelectFromResult<TSource, TResult>;
  }

  /** Column names of this select's projection (internal, for CTE inference). */
  projectionKeys(): readonly string[] | undefined {
    return this.#state.projection === undefined
      ? undefined
      : Object.keys(this.#state.projection);
  }

  union(other: SetOperand<TResult>): CompoundSelectBuilder<TResult> {
    return this.#compound("union", other);
  }

  unionAll(other: SetOperand<TResult>): CompoundSelectBuilder<TResult> {
    return this.#compound("union all", other);
  }

  intersect(other: SetOperand<TResult>): CompoundSelectBuilder<TResult> {
    return this.#compound("intersect", other);
  }

  intersectAll(other: SetOperand<TResult>): CompoundSelectBuilder<TResult> {
    return this.#compound("intersect all", other);
  }

  except(other: SetOperand<TResult>): CompoundSelectBuilder<TResult> {
    return this.#compound("except", other);
  }

  exceptAll(other: SetOperand<TResult>): CompoundSelectBuilder<TResult> {
    return this.#compound("except all", other);
  }

  #compound(
    kind: SetOperationKind,
    other: SetOperand<TResult>,
  ): CompoundSelectBuilder<TResult> {
    return new SisalCompoundSelectBuilder<TResult>(this.#database, {
      first: this.toSql(),
      rest: [{ kind, query: other.toSql() }],
    });
  }

  distinct(): SelectBuilder<TTable, TResult> {
    return this.#with({ distinct: true });
  }

  distinctOn(...columns: unknown[]): SelectBuilder<TTable, TResult> {
    if (columns.length === 0) {
      throw new OrmError("distinctOn requires at least one column", {
        code: "ORM_INVALID_QUERY",
      });
    }
    return this.#with({
      distinctOn: columns.map((column) =>
        isSql(column) ? column : columnToSql(column)
      ),
    });
  }

  for(
    strength: "update" | "share",
    options: ForLockOptions = {},
  ): SelectBuilder<TTable, TResult> {
    if (strength !== "update" && strength !== "share") {
      throw new OrmError('for() strength must be "update" or "share"', {
        code: "ORM_INVALID_QUERY",
      });
    }
    if (options.skipLocked === true && options.noWait === true) {
      throw new OrmError("for() cannot combine skipLocked and noWait", {
        code: "ORM_INVALID_QUERY",
      });
    }
    const of = options.of === undefined
      ? undefined
      : Array.isArray(options.of)
      ? options.of
      : [options.of];
    of?.forEach(assertTable);
    return this.#with({
      forLock: {
        strength,
        ...(of === undefined ? {} : { of }),
        ...(options.skipLocked === true
          ? { mode: "skip locked" as const }
          : options.noWait === true
          ? { mode: "nowait" as const }
          : {}),
      },
    });
  }

  as(
    alias: string,
  ): Subquery<{ readonly [K in keyof TResult]-?: SelectColumnRef }> {
    return makeSubqueryColumns(
      alias,
      this.projectionKeys() ?? [],
      this.toSql(),
    ) as Subquery<{ readonly [K in keyof TResult]-?: SelectColumnRef }>;
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
      fromCte,
      fromSubquery,
      ctes,
      projection,
      distinct,
      distinctOn,
      joins,
      condition,
      groupBy,
      having,
      orderBy,
      limit,
      offset,
      forLock,
    } = this.#state;

    const fromName = table !== undefined
      ? identifier(table.name)
      : fromCte !== undefined
      ? identifier(fromCte)
      : fromSubquery !== undefined
      ? joinSql([
        raw("("),
        fromSubquery.query,
        raw(") as "),
        identifier(fromSubquery.alias),
      ], emptySql())
      : undefined;

    if (fromName === undefined) {
      throw new OrmError("Select query requires a table", {
        code: "ORM_INVALID_QUERY",
      });
    }

    const parts: Sql[] = [];
    if (ctes !== undefined && ctes.length > 0) {
      parts.push(withPrefixSql(ctes));
    }
    if (distinctOn !== undefined && distinctOn.length > 0) {
      parts.push(
        raw("select distinct on ("),
        joinSql([...distinctOn], raw(", ")),
        raw(") "),
      );
    } else {
      parts.push(raw(distinct ? "select distinct " : "select "));
    }
    parts.push(
      projection !== undefined
        ? projectionSql(projection)
        : table !== undefined
        ? tableSelectionSql(table)
        : raw("*"),
    );
    parts.push(raw(" from "), fromName);

    for (const join of joins) {
      assertTable(join.table);
      assertCondition(join.on);
      parts.push(
        // join.kind is a fixed SelectJoinKind enum, never user input.
        // deno-lint-ignore sisal/no-raw-interpolation
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

    if (forLock !== undefined) {
      parts.push(
        raw(forLock.strength === "share" ? " for share" : " for update"),
      );
      if (forLock.of !== undefined && forLock.of.length > 0) {
        parts.push(
          raw(" of "),
          joinSql(forLock.of.map((t) => identifier(t.name)), raw(", ")),
        );
      }
      if (forLock.mode === "skip locked") {
        parts.push(raw(" skip locked"));
      } else if (forLock.mode === "nowait") {
        parts.push(raw(" nowait"));
      }
    }

    return joinSql(parts, emptySql());
  }

  prepare(name?: string): PreparedQuery<TResult[]> {
    return prepareRows<TResult>(this.#database, this.toSql(), name);
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

interface CompoundState {
  readonly first: Sql;
  readonly rest: readonly {
    readonly kind: SetOperationKind;
    readonly query: Sql;
  }[];
  readonly orderBy?: readonly Sql[];
  readonly limit?: number;
  readonly offset?: number;
  /** Carried for CTE column inference when a compound query backs a CTE. */
  readonly projection?: SelectProjection;
}

export class SisalCompoundSelectBuilder<TResult>
  implements CompoundSelectBuilder<TResult> {
  readonly [QUERY_BUILDER_BRAND] = true;
  readonly #database: Database;
  readonly #state: CompoundState;

  constructor(database: Database, state: CompoundState) {
    this.#database = database;
    this.#state = state;
  }

  #append(
    kind: SetOperationKind,
    other: SetOperand<TResult>,
  ): CompoundSelectBuilder<TResult> {
    return new SisalCompoundSelectBuilder<TResult>(this.#database, {
      ...this.#state,
      rest: [...this.#state.rest, { kind, query: other.toSql() }],
    });
  }

  union(other: SetOperand<TResult>): CompoundSelectBuilder<TResult> {
    return this.#append("union", other);
  }

  unionAll(other: SetOperand<TResult>): CompoundSelectBuilder<TResult> {
    return this.#append("union all", other);
  }

  intersect(other: SetOperand<TResult>): CompoundSelectBuilder<TResult> {
    return this.#append("intersect", other);
  }

  intersectAll(other: SetOperand<TResult>): CompoundSelectBuilder<TResult> {
    return this.#append("intersect all", other);
  }

  except(other: SetOperand<TResult>): CompoundSelectBuilder<TResult> {
    return this.#append("except", other);
  }

  exceptAll(other: SetOperand<TResult>): CompoundSelectBuilder<TResult> {
    return this.#append("except all", other);
  }

  orderBy(...terms: unknown[]): CompoundSelectBuilder<TResult> {
    if (terms.length === 0) {
      throw new OrmError("orderBy requires at least one column", {
        code: "ORM_INVALID_QUERY",
      });
    }
    return new SisalCompoundSelectBuilder<TResult>(this.#database, {
      ...this.#state,
      orderBy: terms.map((term) => isSql(term) ? term : columnToSql(term)),
    });
  }

  limit(count: number): CompoundSelectBuilder<TResult> {
    return new SisalCompoundSelectBuilder<TResult>(this.#database, {
      ...this.#state,
      limit: normalizePositiveInteger(count, "limit"),
    });
  }

  offset(count: number): CompoundSelectBuilder<TResult> {
    return new SisalCompoundSelectBuilder<TResult>(this.#database, {
      ...this.#state,
      offset: normalizeNonNegativeInteger(count, "offset"),
    });
  }

  /** Column names of the compound's projection (internal, for CTE inference). */
  projectionKeys(): readonly string[] | undefined {
    return this.#state.projection === undefined
      ? undefined
      : Object.keys(this.#state.projection);
  }

  as(
    alias: string,
  ): Subquery<{ readonly [K in keyof TResult]-?: SelectColumnRef }> {
    return makeSubqueryColumns(
      alias,
      this.projectionKeys() ?? [],
      this.toSql(),
    ) as Subquery<{ readonly [K in keyof TResult]-?: SelectColumnRef }>;
  }

  toSql(): Sql {
    // Operands are not parenthesized: `(SELECT …) UNION (SELECT …)` is valid on
    // Postgres but a syntax error on SQLite, whereas the unwrapped form renders
    // correctly on both. Apply `orderBy`/`limit`/`offset` to the compound (not
    // its operands), since those bind to the whole set operation.
    const parts: Sql[] = [this.#state.first];

    for (const operation of this.#state.rest) {
      // operation.kind is a fixed SetOperationKind enum, never user input.
      // deno-lint-ignore sisal/no-raw-interpolation
      parts.push(raw(` ${operation.kind} `), operation.query);
    }

    if (this.#state.orderBy !== undefined && this.#state.orderBy.length > 0) {
      parts.push(
        raw(" order by "),
        joinSql([...this.#state.orderBy], raw(", ")),
      );
    }

    if (this.#state.limit !== undefined) {
      parts.push(raw(" limit "), paramSql(this.#state.limit));
    }

    if (this.#state.offset !== undefined) {
      parts.push(raw(" offset "), paramSql(this.#state.offset));
    }

    return joinSql(parts, emptySql());
  }

  prepare(name?: string): PreparedQuery<TResult[]> {
    return prepareRows<TResult>(this.#database, this.toSql(), name);
  }

  async execute(): Promise<TResult[]> {
    const result = await this.#database.query<TResult>(this.toSql());
    return result.rows;
  }
}

/** Renders a builder once into a {@link PreparedQuery} returning result rows. */
function prepareRows<T>(
  database: Database,
  query: Sql,
  name: string | undefined,
): PreparedQuery<T[]> {
  const plan = renderToPlan(query, database.dialect);
  return new SisalPreparedQuery<T[]>(plan, name, async (rendered) => {
    const result = await database.query<T>(rendered);
    return result.rows;
  });
}

/** Renders a builder once into a {@link PreparedQuery} returning the result. */
function prepareResult<T>(
  database: Database,
  query: Sql,
  name: string | undefined,
): PreparedQuery<OrmQueryResult<T>> {
  const plan = renderToPlan(query, database.dialect);
  return new SisalPreparedQuery<OrmQueryResult<T>>(
    plan,
    name,
    (rendered) => database.execute<T>(rendered),
  );
}

class SisalPreparedQuery<TExecuteResult>
  implements PreparedQuery<TExecuteResult> {
  readonly name?: string;
  readonly #plan: PreparedPlan;
  readonly #run: (query: SqlQuery) => Promise<TExecuteResult>;

  constructor(
    plan: PreparedPlan,
    name: string | undefined,
    run: (query: SqlQuery) => Promise<TExecuteResult>,
  ) {
    this.#plan = plan;
    if (name !== undefined) {
      this.name = name;
    }
    this.#run = run;
  }

  toSql(values: PlaceholderValues = {}): SqlQuery {
    return fillPreparedPlan(this.#plan, values);
  }

  execute(values: PlaceholderValues = {}): Promise<TExecuteResult> {
    return this.#run(this.toSql(values));
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

function returningSql(
  returning: SelectProjection | boolean,
  table: TableDefinition,
): Sql | undefined {
  if (returning === false) {
    return undefined;
  }
  if (returning === true) {
    return joinSql([raw(" returning "), tableSelectionSql(table)], emptySql());
  }
  return joinSql([raw(" returning "), projectionSql(returning)], emptySql());
}

// The column list for `SELECT *` / `RETURNING *` over a table. When every column
// name equals its property key this stays `*`; once any column is renamed (an
// explicit `.named(...)` or a naming strategy) it expands to an aliased
// projection (`"t"."phys" as "prop"`) so result rows come back keyed by the JS
// property names the inferred row type expects.
function tableSelectionSql(table: TableDefinition): Sql {
  const entries = Object.entries(table.columns) as Array<
    [string, { readonly name: string }]
  >;
  const renamed = entries.some(([property, column]) =>
    column.name !== property
  );
  if (!renamed) {
    return raw("*");
  }
  return joinSql(
    entries.map(([property, column]) =>
      sql`${columnToSql(column)} as ${identifier(property)}`
    ),
    raw(", "),
  );
}

function toConflictTargets(
  target: unknown | readonly unknown[],
): readonly unknown[] {
  return Array.isArray(target) ? target : [target];
}

function conflictTargetSql(target: unknown, table: TableDefinition): Sql {
  // Conflict targets are unqualified column names, e.g. `on conflict ("id")`.
  if (isColumn(target)) {
    return identifier(target.name);
  }
  if (typeof target === "string") {
    // A bare string may be a JS property key (mapped to its physical name) or
    // an already-physical column name; fall back to the literal otherwise.
    return Object.hasOwn(table.columns, target)
      ? identifier(physicalColumnName(table, target))
      : identifier(target);
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
  const targetList = targets.length === 0 ? undefined : joinSql(
    [...targets].map((target) => conflictTargetSql(target, table)),
    raw(", "),
  );

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
    entries.map(([name, value]) =>
      sql`${identifier(physicalColumnName(table, name))} = ${value}`
    ),
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

export class SisalInsertBuilder<TTable extends TableDefinition>
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

    const columnSql = joinSql(
      columnNames.map((name) =>
        identifier(physicalColumnName(this.#table, name))
      ),
    );
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

    const returning = returningSql(this.#returning, this.#table);
    if (returning !== undefined) {
      parts.push(returning);
    }

    return joinSql(parts, emptySql());
  }

  prepare(name?: string): PreparedQuery<OrmQueryResult<InferSelect<TTable>>> {
    return prepareResult<InferSelect<TTable>>(
      this.#database,
      this.toSql(),
      name,
    );
  }

  execute(): Promise<OrmQueryResult<InferSelect<TTable>>> {
    return this.#database.execute<InferSelect<TTable>>(this.toSql());
  }
}

export class SisalUpdateBuilder<TTable extends TableDefinition>
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
      entries.map(([name, value]) =>
        sql`${identifier(physicalColumnName(this.#table, name))} = ${value}`
      ),
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

    const returning = returningSql(this.#returning, this.#table);
    if (returning !== undefined) {
      parts.push(returning);
    }

    return joinSql(parts, emptySql());
  }

  prepare(name?: string): PreparedQuery<OrmQueryResult<InferSelect<TTable>>> {
    return prepareResult<InferSelect<TTable>>(
      this.#database,
      this.toSql(),
      name,
    );
  }

  execute(): Promise<OrmQueryResult<InferSelect<TTable>>> {
    return this.#database.execute<InferSelect<TTable>>(this.toSql());
  }
}

export class SisalDeleteBuilder<TTable extends TableDefinition>
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

    const returning = returningSql(this.#returning, this.#table);
    if (returning !== undefined) {
      parts.push(returning);
    }

    return joinSql(parts, emptySql());
  }

  prepare(name?: string): PreparedQuery<OrmQueryResult<InferSelect<TTable>>> {
    return prepareResult<InferSelect<TTable>>(
      this.#database,
      this.toSql(),
      name,
    );
  }

  execute(): Promise<OrmQueryResult<InferSelect<TTable>>> {
    return this.#database.execute<InferSelect<TTable>>(this.toSql());
  }
}

// Resolves a JS property key to the physical SQL column name a table renders.
// Callers validate membership with assertTableColumn first.
function physicalColumnName(
  table: TableDefinition,
  propertyKey: string,
): string {
  return (table.columns as Record<string, { readonly name: string }>)[
    propertyKey
  ].name;
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
