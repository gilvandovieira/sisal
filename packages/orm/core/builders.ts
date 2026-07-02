/**
 * Immutable query builders (select/insert/update/delete, compound selects,
 * CTEs, derived-table subqueries) and prepared queries.
 *
 * Part of the `@sisal/orm` core; re-exported through `./mod.ts`.
 */

import {
  and,
  asc,
  capabilityGuard,
  type Condition,
  desc,
  DIALECT_CAPABILITIES,
  dialectGuard,
  dialectSql,
  emptySql,
  identifier,
  type InferInsert,
  type InferProjection,
  type InferSelect,
  isColumn,
  isOrderTerm,
  isSql,
  joinSql,
  type OrderTerm,
  OrmError,
  type PlaceholderValues,
  raw,
  type SelectColumnRef,
  type SelectProjection,
  type Sql,
  sql,
  type SqlQuery,
  type TableDefinition,
} from "@sisal/core";
import {
  assertCondition,
  assertTable,
  assertTableColumn,
  attachResultMetadata,
  columnToSql,
  createCondition,
  fillPreparedPlan,
  getResultMetadata,
  paramSql,
  type PreparedPlan,
  QUERY_BUILDER_BRAND,
  renderToPlan,
  type ResultColumnMetadata,
  type ResultRowMetadata,
} from "@sisal/core/unstable-internal";
import type { Database, OrmQueryResult } from "./database.ts";

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

/** The union of JS property keys carried by a tuple of {@link OrderTerm}s. */
export type KeysetKeys<TTerms> = TTerms extends readonly OrderTerm<infer TKey>[]
  ? TKey
  : never;

/** The cursor shape for a keyset over `TResult`, keyed by the ordered columns. */
export type KeysetCursor<TResult, TKeys extends string> = {
  readonly [K in TKeys & keyof TResult]: TResult[K];
};

/** Options for {@link SelectBuilder.keyset}. */
export interface KeysetOptions<
  TResult,
  TTerms extends readonly OrderTerm[],
> {
  /**
   * Ordered `asc()`/`desc()` terms. End with a unique column (e.g. the primary
   * key) so the keyset is a total order.
   */
  readonly orderBy: TTerms;
  /** The cursor to page after (a previous `nextCursor`); omit for the first page. */
  readonly after?: KeysetCursor<TResult, KeysetKeys<TTerms>>;
  /**
   * Predicate shape: nested `or`/`and` (`"expanded"`, the default, works with
   * mixed directions and every dialect) or a SQL row-value comparison
   * (`"row-value"`, e.g. `(a, b) < (x, y)`, which requires a single direction).
   */
  readonly form?: "expanded" | "row-value";
}

/** A page returned by a keyset query: the rows plus the cursor for the next page. */
export interface KeysetPage<TRow, TCursor> {
  readonly rows: TRow[];
  /** Cursor for the next page, or `null` when this was the last (partial) page. */
  readonly nextCursor: TCursor | null;
}

/** A keyset-paginated select; set the page size with `.limit(n)` then run it. */
export interface KeysetSelectBuilder<TRow, TCursor> {
  /** Sets the page size. Required to derive a `nextCursor`. */
  limit(count: number): KeysetSelectBuilder<TRow, TCursor>;
  toSql(): Sql;
  execute(): Promise<KeysetPage<TRow, TCursor>>;
}

/** Fluent builder for `SELECT` queries. */
export interface SelectBuilder<TTable, TResult> {
  /**
   * Selects from a table, common table expression ({@link Database.with}), or
   * subquery aliased as a derived table via {@link SelectBuilder.as}.
   */
  from<TSource extends SelectFromSource>(
    source: TSource,
  ): SelectFromResult<TSource, TResult>;
  /**
   * Selects from a raw `Sql` FROM fragment — a set-returning function (e.g.
   * `jsonTable(...).from`), a table-valued function, or any dialect-native
   * source. The fragment must include its own alias; reference its columns
   * through the projection.
   */
  from(source: Sql): SelectBuilder<unknown, TResult>;

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
   * Keyset (cursor) pagination over `orderBy`. Emits the matching `WHERE`
   * comparison against `after` (a previous page's `nextCursor`; omit for the
   * first page) plus the `ORDER BY`, and returns a builder whose `.execute()`
   * yields `{ rows, nextCursor }`. Set the page size with `.limit(n)`.
   *
   * Always end `orderBy` with a unique column (e.g. the primary key) so the
   * comparison is total. For date/time cursors, prefer database-returned cursor
   * values so adapter precision is preserved at page boundaries.
   */
  keyset<const TTerms extends readonly OrderTerm[]>(
    options: KeysetOptions<TResult, TTerms>,
  ): KeysetSelectBuilder<TResult, KeysetCursor<TResult, KeysetKeys<TTerms>>>;

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

/**
 * A query usable as a CTE body: a `SELECT`/compound, or — **PostgreSQL-only** —
 * a data-modifying `INSERT`/`UPDATE`/`DELETE` with `.returning()`. A
 * data-modifying body lets a `WITH` chain perform a mutation and expose its
 * `RETURNING` columns to the terminal `SELECT`.
 */
export type CteOperand<TResult> =
  | SetOperand<TResult>
  | InsertBuilder<TableDefinition, TResult>
  | UpdateBuilder<TableDefinition, TResult>
  | DeleteBuilder<TableDefinition, TResult>;

/** Intermediate returned by {@link Database.$with}; complete it with `.as`. */
export interface CteBuilder {
  /**
   * Binds the CTE to a query, inferring its columns from the query's projection
   * — a `SELECT`, or an `INSERT`/`UPDATE`/`DELETE … RETURNING` (PostgreSQL-only).
   */
  as<TResult>(
    query: CteOperand<TResult>,
  ): Cte<{ readonly [K in keyof TResult]-?: SelectColumnRef }>;
}

/**
 * Intermediate returned by {@link Database.$withRecursive}; complete it with
 * `.as((self) => …)`. The declared column list types `self`, the CTE's own
 * reference inside its body.
 */
export interface RecursiveCteBuilder<TColumn extends string> {
  /**
   * Binds the recursive CTE body. `build` receives the CTE's self-reference
   * (usable in `from()` / mutation sources like any CTE) and must return the
   * classic recursive shape: a base `SELECT` compounded with the recursive
   * step, e.g. `base.unionAll(step)`. Every supported engine renders
   * `WITH RECURSIVE` at Sisal's version floors; bound the recursion with an
   * explicit depth column and `WHERE depth < n` predicate in the step — the
   * portable cycle guard (PostgreSQL 14's `CYCLE` clause is not rendered).
   */
  as<TResult>(
    build: (
      self: Cte<{ readonly [K in TColumn]: SelectColumnRef }>,
    ) => CteOperand<TResult>,
  ): Cte<{ readonly [K in TColumn]: SelectColumnRef }>;
}

/** Query root seeded with CTEs, returned by {@link Database.with}. */
export interface WithQueryBuilder {
  select(): SelectBuilder<unknown, unknown>;
  select<TProjection extends SelectProjection>(
    projection: TProjection,
  ): SelectBuilder<unknown, InferProjection<TProjection>>;
  /**
   * Terminates the `WITH` chain in an `INSERT`, prepending the CTEs. The chain's
   * CTE bodies must be `SELECT`s on the SQLite family (a data-modifying CTE body
   * is PostgreSQL-only and throws its own guard).
   */
  insert<TTable extends TableDefinition>(
    table: TTable,
  ): InsertBuilder<TTable>;
  /** Terminates the `WITH` chain in an `UPDATE`, prepending the CTEs. */
  update<TTable extends TableDefinition>(
    table: TTable,
  ): UpdateBuilder<TTable>;
  /** Terminates the `WITH` chain in a `DELETE`, prepending the CTEs. */
  delete<TTable extends TableDefinition>(
    table: TTable,
  ): DeleteBuilder<TTable>;
}

/**
 * Insert row values: each column accepts its literal type or a {@link Sql}
 * expression. Literals bind as parameters; `Sql` values render inline.
 */
export type InsertValues<TTable extends TableDefinition> = {
  readonly [K in keyof InferInsert<TTable>]: InferInsert<TTable>[K] | Sql;
};

/**
 * Update/upsert assignments: each column set to its literal type or a `Sql`
 * expression, all columns optional (`UPDATE ... SET`).
 */
export type UpdateValues<TTable extends TableDefinition> = Partial<
  InsertValues<TTable>
>;

/** Fluent builder for `INSERT` queries. */
export interface InsertBuilder<
  TTable extends TableDefinition,
  TReturn = InferSelect<TTable>,
> {
  values(
    value: InsertValues<TTable> | InsertValues<TTable>[],
  ): InsertBuilder<TTable, TReturn>;

  /**
   * `INSERT INTO t (cols) SELECT …`: insert the rows a query produces instead of
   * literal `values(...)`. The query's projected keys become the target columns
   * (each must be a column of `t`), so an insert can read another CTE's
   * `RETURNING`. Mutually exclusive with `.values(...)`.
   */
  select(query: SetOperand<unknown>): InsertBuilder<TTable, TReturn>;

  /** `ON CONFLICT [(target)] DO NOTHING`. */
  onConflictDoNothing(
    config?: { readonly target?: unknown | readonly unknown[] },
  ): InsertBuilder<TTable, TReturn>;

  /** `ON CONFLICT (target) DO UPDATE SET ... [WHERE ...]` (upsert). */
  onConflictDoUpdate(
    config: {
      readonly target: unknown | readonly unknown[];
      readonly set: UpdateValues<TTable>;
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
    values: UpdateValues<TTable>,
  ): UpdateBuilder<TTable, TReturn>;

  /**
   * `UPDATE … FROM <source>`: an auxiliary table, CTE, or derived-table subquery
   * the `SET`/`WHERE` can reference (e.g. `update(posts).set({ … }).from(scores)
   * .where(eq(posts.columns.id, scores.id))`). Lets one CTE's mutation read
   * another CTE's `RETURNING`.
   */
  from(source: SelectFromSource): UpdateBuilder<TTable, TReturn>;

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
  /**
   * `DELETE … USING <source>`: an auxiliary table, CTE, or subquery the `WHERE`
   * can join against (the `DELETE` mirror of `UPDATE … FROM`).
   */
  using(source: SelectFromSource): DeleteBuilder<TTable, TReturn>;

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
  /** A raw `Sql` FROM fragment (a set-returning/table-valued function). */
  readonly fromRaw?: Sql;
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
  /** True for `WITH RECURSIVE` members (declared via `db.$withRecursive`). */
  readonly recursive?: boolean;
  /**
   * Explicit CTE column list, rendered as `name ("a", "b")`. Required for
   * recursive CTEs, whose self-reference exists before the body's projection.
   */
  readonly columnNames?: readonly string[];
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

// CTE references consumed as a `from(...)` source. `$withRecursive` checks its
// self-reference is in here after building the body: a recursive step that names
// the self-reference only in SELECT/WHERE (never in FROM) renders SQL where the
// recursive CTE is absent from the FROM clause — invalid on every engine.
export const CTE_FROM_SOURCES = new WeakSet<object>();

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

// Renders a mutation's auxiliary relation (an `UPDATE … FROM` / `DELETE …
// USING` source): a table or CTE renders as its quoted name; a derived-table
// subquery renders as `(<query>) as <alias>`. Lets the mutation reference
// another CTE's columns (e.g. `update posts set … from computed`).
function mutationRelationSql(source: SelectFromSource): Sql {
  if (isCte(source)) {
    return identifier(CTE_DEFINITIONS.get(source)!.name);
  }
  if (isSubquery(source)) {
    const definition = SUBQUERY_DEFINITIONS.get(source)!;
    return joinSql([
      raw("("),
      definition.query,
      raw(") as "),
      identifier(definition.alias),
    ], emptySql());
  }
  assertTable(source);
  return identifier((source as TableDefinition).name);
}

function withPrefixSql(ctes: readonly CteDefinition[]): Sql {
  // One RECURSIVE keyword covers the whole WITH list (SQL grammar); plain
  // members are unaffected by it on every supported engine.
  const recursive = ctes.some((cte) => cte.recursive === true);
  return joinSql([
    raw(recursive ? "with recursive " : "with "),
    joinSql(
      ctes.map((cte) =>
        joinSql(
          [
            identifier(cte.name),
            cte.columnNames === undefined || cte.columnNames.length === 0
              ? emptySql()
              : joinSql([
                raw(" ("),
                joinSql(
                  cte.columnNames.map((column) => identifier(column)),
                  raw(", "),
                ),
                raw(")"),
              ], emptySql()),
            raw(" as ("),
            cte.query,
            raw(")"),
          ],
          emptySql(),
        )
      ),
      raw(", "),
    ),
    raw(" "),
  ], emptySql());
}

// MariaDB accepts a `WITH` prefix only on SELECT — attaching one to
// INSERT/UPDATE/DELETE is a syntax error there (verified on 11.8.8), while
// MySQL 8+ allows all three. Guarded per variant so a detected mariadb
// identity fails typed instead of with a raw 1064.
function mutationWithPrefixSql(
  construct: string,
  ctes: readonly CteDefinition[],
): Sql {
  return joinSql([
    capabilityGuard(DIALECT_CAPABILITIES.mutationCte, construct),
    withPrefixSql(ctes),
  ], emptySql());
}

/**
 * Column keys a data-modifying CTE body (`INSERT`/`UPDATE`/`DELETE`) exposes via
 * `RETURNING`. A body without `.returning()` exposes no columns and cannot seed
 * a referenceable CTE, so this throws.
 */
function mutationCteColumnKeys(
  returning: SelectProjection | boolean,
  table: TableDefinition,
  operation: string,
): readonly string[] {
  if (returning === false) {
    throw new OrmError(
      `a data-modifying CTE body (${operation}) requires .returning()`,
      { code: "ORM_INVALID_QUERY" },
    );
  }
  return returning === true
    ? Object.keys(table.columns)
    : Object.keys(returning);
}

/** The projected column keys a query exposes when used as a CTE body. */
export function cteColumnKeys(query: CteOperand<unknown>): readonly string[] {
  if (query instanceof SisalSelectBuilder) {
    return query.projectionKeys() ?? [];
  }
  if (query instanceof SisalCompoundSelectBuilder) {
    return query.projectionKeys() ?? [];
  }
  if (
    query instanceof SisalInsertBuilder ||
    query instanceof SisalUpdateBuilder ||
    query instanceof SisalDeleteBuilder
  ) {
    return query.returningColumnKeys();
  }
  return [];
}

/**
 * The CTE body SQL for a query. Data-modifying bodies (an `INSERT`/`UPDATE`/
 * `DELETE` inside a `WITH`) are **PostgreSQL-only**, so they carry a dialect
 * guard that throws a typed `OrmError` if the chain is rendered for a
 * SQLite-family dialect.
 */
export function cteBodySql(query: CteOperand<unknown>): Sql {
  if (
    query instanceof SisalInsertBuilder ||
    query instanceof SisalUpdateBuilder ||
    query instanceof SisalDeleteBuilder
  ) {
    return sql`${
      capabilityGuard(DIALECT_CAPABILITIES.dataModifyingCte)
    }${query.toSql()}`;
  }
  return query.toSql();
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
  ): SelectFromResult<TSource, TResult>;
  from(source: Sql): SelectBuilder<unknown, TResult>;
  from(
    source: SelectFromSource | Sql,
  ): SelectFromResult<SelectFromSource, TResult> {
    if (isSql(source)) {
      return new SisalSelectBuilder(this.#database, {
        ...this.#state,
        table: undefined,
        fromCte: undefined,
        fromSubquery: undefined,
        fromRaw: source,
      }) as unknown as SelectFromResult<SelectFromSource, TResult>;
    }
    if (isSubquery(source)) {
      const definition = SUBQUERY_DEFINITIONS.get(source)!;
      return new SisalSelectBuilder(this.#database, {
        ...this.#state,
        table: undefined,
        fromCte: undefined,
        fromSubquery: definition,
      }) as unknown as SelectFromResult<SelectFromSource, TResult>;
    }
    if (isCte(source)) {
      const definition = CTE_DEFINITIONS.get(source)!;
      // Record that this CTE was used as a FROM source (the recursive-CTE guard
      // in `$withRecursive` reads this).
      CTE_FROM_SOURCES.add(source);
      return new SisalSelectBuilder(this.#database, {
        ...this.#state,
        table: undefined,
        fromSubquery: undefined,
        fromCte: definition.name,
      }) as unknown as SelectFromResult<SelectFromSource, TResult>;
    }
    assertTable(source);
    return new SisalSelectBuilder(this.#database, {
      ...this.#state,
      table: source,
      fromCte: undefined,
      fromSubquery: undefined,
    }) as unknown as SelectFromResult<SelectFromSource, TResult>;
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

  keyset<const TTerms extends readonly OrderTerm[]>(
    options: KeysetOptions<TResult, TTerms>,
  ): KeysetSelectBuilder<TResult, KeysetCursor<TResult, KeysetKeys<TTerms>>> {
    const terms = normalizeKeysetTerms(options.orderBy);
    const keysetCondition = options.after === undefined
      ? undefined
      : createCondition(
        keysetPredicate(
          terms,
          options.after as Record<string, unknown>,
          options.form ?? "expanded",
        ),
      );
    const condition = this.#state.condition === undefined
      ? keysetCondition
      : keysetCondition === undefined
      ? this.#state.condition
      : and(this.#state.condition, keysetCondition);
    const builder = new SisalSelectBuilder<TTable, TResult>(this.#database, {
      ...this.#state,
      ...(condition === undefined ? {} : { condition }),
      orderBy: terms.map((term) => term.term),
    });
    return new SisalKeysetSelectBuilder<
      TResult,
      KeysetCursor<TResult, KeysetKeys<TTerms>>
    >(
      builder as unknown as SelectBuilder<unknown, TResult>,
      terms.map((term) => term.key),
    );
  }

  toSql(): Sql {
    const {
      table,
      fromCte,
      fromSubquery,
      fromRaw,
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
      : fromRaw !== undefined
      ? fromRaw
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
        capabilityGuard(DIALECT_CAPABILITIES.distinctOn),
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
      // Neither MySQL nor MariaDB has FULL OUTER JOIN (C5 probe) — guard it
      // instead of rendering SQL both engines reject. Right joins are fine.
      if (join.kind === "full") {
        parts.push(capabilityGuard(DIALECT_CAPABILITIES.fullJoin));
      }
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
        capabilityGuard(DIALECT_CAPABILITIES.rowLocking),
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

    return attachResultMetadata(
      joinSql(parts, emptySql()),
      selectResultMetadata(table, projection),
    );
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

/** Internal: an order term resolved to its column, key, and direction. */
interface NormalizedKeysetTerm {
  readonly term: OrderTerm;
  readonly key: string;
  readonly column: unknown;
  readonly direction: "asc" | "desc";
}

function normalizeKeysetTerms(
  orderBy: readonly OrderTerm[],
): NormalizedKeysetTerm[] {
  if (!Array.isArray(orderBy) || orderBy.length === 0) {
    throw new OrmError("keyset requires at least one orderBy term", {
      code: "ORM_INVALID_QUERY",
    });
  }
  return orderBy.map((term) => {
    if (!isOrderTerm(term)) {
      throw new OrmError("keyset orderBy expects asc()/desc() terms", {
        code: "ORM_INVALID_QUERY",
      });
    }
    const column = term.column;
    if (!isColumn(column)) {
      throw new OrmError("keyset orderBy terms must be table columns", {
        code: "ORM_INVALID_COLUMN",
      });
    }
    return {
      term,
      key: column.propertyName ?? column.name,
      column,
      direction: term.direction,
    };
  });
}

function keysetPredicate(
  terms: readonly NormalizedKeysetTerm[],
  after: Record<string, unknown>,
  form: "expanded" | "row-value",
): Sql {
  const values = terms.map((term) => {
    if (!Object.hasOwn(after, term.key)) {
      throw new OrmError("keyset cursor is missing a column value", {
        code: "ORM_INVALID_QUERY",
        details: { column: term.key },
      });
    }
    return after[term.key];
  });
  return form === "row-value"
    ? rowValueKeysetSql(terms, values)
    : expandedKeysetSql(terms, values);
}

// `(a < $1) or (a = $2 and b < $3) or ...` — the lexicographic "after the
// cursor" comparison, honoring each column's own direction. Always valid.
function expandedKeysetSql(
  terms: readonly NormalizedKeysetTerm[],
  values: readonly unknown[],
): Sql {
  const clauses = terms.map((term, index) => {
    const parts: Sql[] = [];
    for (let j = 0; j < index; j += 1) {
      parts.push(sql`${columnToSql(terms[j].column)} = ${values[j]}`);
    }
    const comparator = term.direction === "desc" ? "<" : ">";
    parts.push(
      sql`${columnToSql(term.column)} ${raw(comparator)} ${values[index]}`,
    );
    return joinSql(
      [raw("("), joinSql(parts, raw(" and ")), raw(")")],
      emptySql(),
    );
  });
  return joinSql(clauses, raw(" or "));
}

// `(a, b, c) < ($1, $2, $3)` — a SQL row-value comparison. Requires a single
// direction across all terms; Postgres/SQLite/MySQL support row values.
function rowValueKeysetSql(
  terms: readonly NormalizedKeysetTerm[],
  values: readonly unknown[],
): Sql {
  if (new Set(terms.map((term) => term.direction)).size > 1) {
    throw new OrmError(
      'keyset form "row-value" requires a single sort direction',
      { code: "ORM_INVALID_QUERY" },
    );
  }
  const comparator = terms[0].direction === "desc" ? "<" : ">";
  return joinSql([
    raw("("),
    joinSql(terms.map((term) => columnToSql(term.column)), raw(", ")),
    raw(") "),
    raw(comparator),
    raw(" ("),
    joinSql(values.map((value) => paramSql(value)), raw(", ")),
    raw(")"),
  ], emptySql());
}

class SisalKeysetSelectBuilder<TRow, TCursor>
  implements KeysetSelectBuilder<TRow, TCursor> {
  readonly #builder: SelectBuilder<unknown, TRow>;
  readonly #keys: readonly string[];
  readonly #limit?: number;

  constructor(
    builder: SelectBuilder<unknown, TRow>,
    keys: readonly string[],
    limit?: number,
  ) {
    this.#builder = builder;
    this.#keys = keys;
    if (limit !== undefined) {
      this.#limit = limit;
    }
  }

  limit(count: number): KeysetSelectBuilder<TRow, TCursor> {
    return new SisalKeysetSelectBuilder<TRow, TCursor>(
      this.#builder.limit(count),
      this.#keys,
      Math.floor(count),
    );
  }

  toSql(): Sql {
    return this.#builder.toSql();
  }

  async execute(): Promise<KeysetPage<TRow, TCursor>> {
    const rows = await this.#builder.execute();
    return { rows, nextCursor: this.#nextCursor(rows) };
  }

  // A nextCursor exists only when a full page came back (rows.length === limit);
  // a short page is the last page.
  #nextCursor(rows: readonly TRow[]): TCursor | null {
    if (
      this.#limit === undefined || rows.length === 0 ||
      rows.length < this.#limit
    ) {
      return null;
    }
    const last = rows[rows.length - 1] as Record<string, unknown>;
    const cursor: Record<string, unknown> = {};
    for (const key of this.#keys) {
      cursor[key] = last[key];
    }
    return cursor as TCursor;
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
  // Render with the full dialect identity, not the bare dialect: the plan is
  // baked once here and replayed verbatim at execute time, so dropping
  // variant/version would fail closed on variant/version-gated constructs
  // (e.g. MariaDB `INSERT … RETURNING`) that the normal execute path renders.
  const plan = renderToPlan(query, database.dialectIdentity);
  return new SisalPreparedQuery<T[]>(
    plan,
    name,
    getResultMetadata(query),
    async (rendered) => {
      const result = await database.query<T>(rendered);
      return result.rows;
    },
  );
}

/** Renders a builder once into a {@link PreparedQuery} returning the result. */
function prepareResult<T>(
  database: Database,
  query: Sql,
  name: string | undefined,
): PreparedQuery<OrmQueryResult<T>> {
  // See prepareRows: render with the full identity so the baked plan keeps
  // variant/version-gated rendering the normal execute path would apply.
  const plan = renderToPlan(query, database.dialectIdentity);
  return new SisalPreparedQuery<OrmQueryResult<T>>(
    plan,
    name,
    getResultMetadata(query),
    (rendered) => database.execute<T>(rendered),
  );
}

class SisalPreparedQuery<TExecuteResult>
  implements PreparedQuery<TExecuteResult> {
  readonly name?: string;
  readonly #plan: PreparedPlan;
  readonly #metadata?: ResultRowMetadata;
  readonly #run: (query: SqlQuery) => Promise<TExecuteResult>;

  constructor(
    plan: PreparedPlan,
    name: string | undefined,
    metadata: ResultRowMetadata | undefined,
    run: (query: SqlQuery) => Promise<TExecuteResult>,
  ) {
    this.#plan = plan;
    this.#metadata = metadata;
    if (name !== undefined) {
      this.name = name;
    }
    this.#run = run;
  }

  toSql(values: PlaceholderValues = {}): SqlQuery {
    return attachResultMetadata(
      fillPreparedPlan(this.#plan, values),
      this.#metadata,
    );
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

function selectResultMetadata(
  table: TableDefinition | undefined,
  projection: SelectProjection | undefined,
): ResultRowMetadata | undefined {
  if (projection !== undefined) {
    return projectionResultMetadata(projection);
  }
  return table === undefined ? undefined : tableResultMetadata(table);
}

function projectionResultMetadata(
  projection: SelectProjection,
): ResultRowMetadata | undefined {
  const metadata: Record<string, ResultColumnMetadata> = {};
  for (const [alias, value] of Object.entries(projection)) {
    if (isColumn(value)) {
      metadata[alias] = value;
    }
  }
  return Object.keys(metadata).length === 0 ? undefined : metadata;
}

function tableResultMetadata(table: TableDefinition): ResultRowMetadata {
  const metadata: Record<string, ResultColumnMetadata> = {};
  for (const [propertyName, column] of Object.entries(table.columns)) {
    metadata[propertyName] = column;
  }
  return metadata;
}

// MySQL has no RETURNING on any mutation; MariaDB's is per-statement AND
// per-version (DELETE 10.0.5+, INSERT/REPLACE 10.5+, UPDATE only 13.0+). The
// registry capability per statement kind expresses exactly that: the
// version-less "mysql" dialect throws a typed error, and each kind carries
// the MariaDB refinement that lifts the guard once an adapter renders with an
// identified server. A fetch-by-key fallback for MySQL proper is an
// adapter/executor concern (a second round trip, not a render rewrite).
const RETURNING_CAPABILITIES = {
  insert: DIALECT_CAPABILITIES.insertReturning,
  update: DIALECT_CAPABILITIES.updateReturning,
  delete: DIALECT_CAPABILITIES.deleteReturning,
} as const;

function returningSql(
  returning: SelectProjection | boolean,
  table: TableDefinition,
  kind: "insert" | "update" | "delete",
): Sql | undefined {
  if (returning === false) {
    return undefined;
  }
  const guard = capabilityGuard(RETURNING_CAPABILITIES[kind]);
  if (returning === true) {
    return joinSql(
      [guard, raw(" returning "), tableSelectionSql(table)],
      emptySql(),
    );
  }
  return joinSql(
    [guard, raw(" returning "), projectionSql(returning)],
    emptySql(),
  );
}

function returningResultMetadata(
  returning: SelectProjection | boolean,
  table: TableDefinition,
): ResultRowMetadata | undefined {
  if (returning === false) {
    return undefined;
  }
  if (returning === true) {
    return tableResultMetadata(table);
  }
  return projectionResultMetadata(returning);
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

// The column a MySQL `onConflictDoNothing` no-op self-assignment uses: the
// first resolvable conflict-target column, else the first primary-key column,
// else the first declared column (a table always has at least one).
function noopAssignmentColumn(
  targets: readonly unknown[],
  table: TableDefinition,
): string {
  for (const target of targets) {
    if (isColumn(target)) {
      return target.name;
    }
    if (typeof target === "string") {
      return Object.hasOwn(table.columns, target)
        ? physicalColumnName(table, target)
        : target;
    }
    // A raw-Sql expression target cannot become an assignment; keep looking.
  }
  const columns = Object.values(table.columns) as Array<
    { readonly name: string; readonly primaryKey?: boolean }
  >;
  return (columns.find((column) => column.primaryKey) ?? columns[0]).name;
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

  // MySQL's `ON DUPLICATE KEY UPDATE` fires on ANY unique-key violation: the
  // conflict target is validated (types + membership, above) but cannot be
  // rendered. Semantics coincide with Postgres/SQLite exactly when the target
  // is the table's only unique constraint (the usual upsert grain).
  if (conflict.kind === "nothing") {
    const conflictForm = targetList === undefined
      ? raw(" on conflict do nothing")
      : joinSql(
        [raw(" on conflict ("), targetList, raw(") do nothing")],
        emptySql(),
      );
    // MySQL has no DO NOTHING; the standard idiom is a no-op self-assignment
    // (`INSERT IGNORE` is not it — it swallows unrelated errors too).
    const noop = identifier(noopAssignmentColumn(targets, table));
    return dialectSql("onConflictDoNothing", {
      mysql: sql` on duplicate key update ${noop} = ${noop}`,
    }, conflictForm);
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

  const conflictForm = joinSql(parts, emptySql());
  // The conflict `where` has no MySQL equivalent — rendering one under the
  // mysql dialect throws a typed ORM_DIALECT_UNSUPPORTED (an empty dialect
  // chunk with no mysql variant and no fallback).
  const forwardRef = conflict.where === undefined
    ? odkuBackwardReference(conflict.set, table)
    : undefined;
  const duplicateKeyForm = conflict.where !== undefined
    ? dialectSql('onConflictDoUpdate "where" (conflict condition)', {})
    // MySQL/MariaDB evaluate `ON DUPLICATE KEY UPDATE` assignments
    // left-to-right, so an assignment that reads a sibling column set
    // *earlier* sees that column's already-updated value — while PostgreSQL
    // reads the pre-update row uniformly. Rather than let the same builder
    // silently compute different results per engine, the mysql render throws
    // a typed guard; the fix is to order the derived column first (so it reads
    // the old value) or reference the proposed row with `excluded()`.
    : forwardRef !== undefined
    ? sql`${
      dialectGuard(
        `ON DUPLICATE KEY UPDATE assignment for "${forwardRef.column}" reads ` +
          `"${forwardRef.reads}", which is set earlier in the same statement ` +
          `(MySQL evaluates assignments left-to-right, so it reads the ` +
          `updated value; put the derived column first or use excluded())`,
        ["mysql"],
      )
    } on duplicate key update ${setSql}`
    : sql` on duplicate key update ${setSql}`;
  return dialectSql("upsert", {
    mysql: duplicateKeyForm,
  }, conflictForm);
}

// Recursively true when `value`'s chunks reference any of the table-qualified
// identifiers in `qualified` (a bare `t.col` ref renders as a nested `sql`
// chunk holding an `identifier` chunk `"t.col"`; `excluded()` renders through
// a `dialect` chunk with an *unqualified* name, so it is never matched — the
// proposed-row reference is always safe). Dialect-mapped helpers such as
// `greatest()` hide their operands inside `dialect` chunks, so those variants
// must be walked too.
function sqlReferencesQualified(
  value: Sql,
  qualified: ReadonlySet<string>,
): boolean {
  for (const chunk of value.chunks) {
    if (chunk.kind === "identifier" && qualified.has(chunk.value)) {
      return true;
    }
    if (
      chunk.kind === "sql" && sqlReferencesQualified(chunk.value, qualified)
    ) {
      return true;
    }
    if (chunk.kind === "dialect") {
      for (const variant of Object.values(chunk.variants)) {
        if (
          variant !== undefined && sqlReferencesQualified(variant, qualified)
        ) {
          return true;
        }
      }
      if (
        chunk.fallback !== undefined &&
        sqlReferencesQualified(chunk.fallback, qualified)
      ) {
        return true;
      }
    }
  }
  return false;
}

// Detects the first ODKU `set` assignment whose expression reads a *different*
// sibling column set earlier in the same list — the MySQL left-to-right
// footgun. Self-references (`col = col + 1`) and forward references
// (derived-column-first) are safe and return undefined.
function odkuBackwardReference(
  set: Record<string, unknown>,
  table: TableDefinition,
): { readonly column: string; readonly reads: string } | undefined {
  const entries = Object.entries(set).filter(([, v]) => v !== undefined);
  const seen = new Map<string, string>(); // qualified id -> property key
  for (const [key, value] of entries) {
    if (isSql(value)) {
      for (const [qualified, earlierKey] of seen) {
        if (sqlReferencesQualified(value, new Set([qualified]))) {
          return { column: key, reads: earlierKey };
        }
      }
    }
    seen.set(`${table.name}.${physicalColumnName(table, key)}`, key);
  }
  return undefined;
}

type InsertConflict =
  | { readonly kind: "nothing"; readonly target?: readonly unknown[] }
  | {
    readonly kind: "update";
    readonly target: readonly unknown[];
    readonly set: Record<string, unknown>;
    readonly where?: Condition;
  };

/** Immutable state of an `INSERT` builder. */
interface InsertState<TTable extends TableDefinition> {
  readonly table: TTable;
  readonly rows?: Array<InsertValues<TTable>>;
  readonly returning: SelectProjection | boolean;
  readonly conflict?: InsertConflict;
  /** CTEs prepended as a `WITH` (mutating terminal of `db.with(...)`). */
  readonly ctes?: readonly CteDefinition[];
  /** `INSERT INTO t (cols) <query>` source (mutually exclusive with `rows`). */
  readonly select?: { readonly keys: readonly string[]; readonly body: Sql };
}

export class SisalInsertBuilder<TTable extends TableDefinition>
  implements InsertBuilder<TTable> {
  readonly #database: Database;
  readonly #state: InsertState<TTable>;

  constructor(database: Database, state: InsertState<TTable>) {
    this.#database = database;
    this.#state = state;
  }

  #with(patch: Partial<InsertState<TTable>>): SisalInsertBuilder<TTable> {
    return new SisalInsertBuilder<TTable>(this.#database, {
      ...this.#state,
      ...patch,
    });
  }

  values(
    value: InsertValues<TTable> | InsertValues<TTable>[],
  ): InsertBuilder<TTable> {
    const rows = Array.isArray(value) ? value : [value];

    if (rows.length === 0) {
      throw new OrmError("Insert values cannot be empty", {
        code: "ORM_INVALID_QUERY",
      });
    }

    return this.#with({ rows: rows.map((row) => ({ ...row })) });
  }

  select(query: SetOperand<unknown>): InsertBuilder<TTable> {
    const keys = cteColumnKeys(query as CteOperand<unknown>);
    if (keys.length === 0) {
      throw new OrmError("insert().select() requires a projected query", {
        code: "ORM_INVALID_QUERY",
      });
    }
    for (const key of keys) {
      assertTableColumn(this.#state.table, key);
    }
    return this.#with({ select: { keys, body: query.toSql() } });
  }

  onConflictDoNothing(
    config: { readonly target?: unknown | readonly unknown[] } = {},
  ): InsertBuilder<TTable> {
    return this.#with({
      conflict: {
        kind: "nothing",
        ...(config.target === undefined
          ? {}
          : { target: toConflictTargets(config.target) }),
      },
    });
  }

  onConflictDoUpdate(
    config: {
      readonly target: unknown | readonly unknown[];
      readonly set: UpdateValues<TTable>;
      readonly where?: Condition;
    },
  ): InsertBuilder<TTable> {
    const target = toConflictTargets(config.target);
    if (target.length === 0) {
      throw new OrmError("onConflictDoUpdate requires a conflict target", {
        code: "ORM_INVALID_QUERY",
      });
    }
    return this.#with({
      conflict: {
        kind: "update",
        target,
        set: { ...(config.set as Record<string, unknown>) },
        ...(config.where === undefined ? {} : { where: config.where }),
      },
    });
  }

  returning(): InsertBuilder<TTable, InferSelect<TTable>>;
  returning<TProjection extends SelectProjection>(
    projection: TProjection,
  ): InsertBuilder<TTable, InferProjection<TProjection>>;
  returning(
    projection?: SelectProjection,
  ): InsertBuilder<TTable, InferSelect<TTable>> {
    return this.#with({
      returning: projection ?? true,
    }) as unknown as InsertBuilder<TTable, InferSelect<TTable>>;
  }

  returningColumnKeys(): readonly string[] {
    return mutationCteColumnKeys(
      this.#state.returning,
      this.#state.table,
      "insert",
    );
  }

  toSql(): Sql {
    const { table, rows, returning, conflict, ctes, select } = this.#state;
    if (rows !== undefined && select !== undefined) {
      throw new OrmError("Insert cannot combine .values() and .select()", {
        code: "ORM_INVALID_QUERY",
      });
    }

    const parts: Sql[] = [];
    if (ctes !== undefined && ctes.length > 0) {
      parts.push(mutationWithPrefixSql("WITH … INSERT", ctes));
    }

    if (select !== undefined) {
      // INSERT INTO t (cols) <query> — the query supplies the rows.
      parts.push(
        raw("insert into "),
        identifier(table.name),
        raw(" ("),
        joinSql(
          select.keys.map((key) => identifier(physicalColumnName(table, key))),
        ),
        raw(") "),
        select.body,
      );
    } else {
      if (rows === undefined || rows.length === 0) {
        throw new OrmError("Insert query requires values", {
          code: "ORM_INVALID_QUERY",
        });
      }

      const columnNames = getInsertColumnNames(table, rows);
      if (columnNames.length === 0) {
        throw new OrmError("Insert query has no columns", {
          code: "ORM_INVALID_QUERY",
        });
      }

      const columnSql = joinSql(
        columnNames.map((name) => identifier(physicalColumnName(table, name))),
      );
      const valuesSql = joinSql(
        rows.map((row) =>
          sql`(${
            joinSql(
              columnNames.map((name) => {
                const value = (row as Record<string, unknown>)[name];
                // A `Sql` expression (e.g. sql`now()`) renders inline; any
                // other value binds as a parameter.
                return isSql(value) ? value : paramSql(value);
              }),
            )
          })`
        ),
      );
      parts.push(
        raw("insert into "),
        identifier(table.name),
        raw(" ("),
        columnSql,
        raw(") values "),
        valuesSql,
      );
    }

    const conflictPart = conflictSql(conflict, table);
    if (conflictPart !== undefined) {
      parts.push(conflictPart);
    }

    const returningPart = returningSql(returning, table, "insert");
    if (returningPart !== undefined) {
      parts.push(returningPart);
    }

    return attachResultMetadata(
      joinSql(parts, emptySql()),
      returningResultMetadata(returning, table),
    );
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

/** Immutable state of an `UPDATE` builder. */
interface UpdateState<TTable extends TableDefinition> {
  readonly table: TTable;
  readonly values?: UpdateValues<TTable>;
  readonly condition?: Condition;
  readonly allowAllRows: boolean;
  readonly returning: SelectProjection | boolean;
  /** CTEs prepended as a `WITH` (mutating terminal of `db.with(...)`). */
  readonly ctes?: readonly CteDefinition[];
  /** `UPDATE … FROM <source>` auxiliary relation (a table/CTE/subquery). */
  readonly from?: Sql;
}

export class SisalUpdateBuilder<TTable extends TableDefinition>
  implements UpdateBuilder<TTable> {
  readonly #database: Database;
  readonly #state: UpdateState<TTable>;

  constructor(database: Database, state: UpdateState<TTable>) {
    this.#database = database;
    this.#state = state;
  }

  #with(patch: Partial<UpdateState<TTable>>): SisalUpdateBuilder<TTable> {
    return new SisalUpdateBuilder<TTable>(this.#database, {
      ...this.#state,
      ...patch,
    });
  }

  set(values: UpdateValues<TTable>): UpdateBuilder<TTable> {
    return this.#with({ values: { ...values } });
  }

  from(source: SelectFromSource): UpdateBuilder<TTable> {
    return this.#with({ from: mutationRelationSql(source) });
  }

  where(condition: Condition): UpdateBuilder<TTable> {
    assertCondition(condition);
    return this.#with({ condition });
  }

  unsafeAllowAllRows(): UpdateBuilder<TTable> {
    return this.#with({ allowAllRows: true });
  }

  returning(): UpdateBuilder<TTable, InferSelect<TTable>>;
  returning<TProjection extends SelectProjection>(
    projection: TProjection,
  ): UpdateBuilder<TTable, InferProjection<TProjection>>;
  returning(
    projection?: SelectProjection,
  ): UpdateBuilder<TTable, InferSelect<TTable>> {
    return this.#with({
      returning: projection ?? true,
    }) as unknown as UpdateBuilder<TTable, InferSelect<TTable>>;
  }

  returningColumnKeys(): readonly string[] {
    return mutationCteColumnKeys(
      this.#state.returning,
      this.#state.table,
      "update",
    );
  }

  toSql(): Sql {
    const { table, values, condition, allowAllRows, returning, ctes, from } =
      this.#state;
    if (values === undefined) {
      throw new OrmError("Update query requires set values", {
        code: "ORM_INVALID_QUERY",
      });
    }

    const entries = getDefinedEntries(table, values);
    appendOnUpdateEntries(table, entries);

    if (entries.length === 0) {
      throw new OrmError("Update query has no set values", {
        code: "ORM_INVALID_QUERY",
      });
    }

    const setSql = joinSql(
      entries.map(([name, value]) =>
        sql`${identifier(physicalColumnName(table, name))} = ${value}`
      ),
    );
    const mysqlSetSql = joinSql(
      entries.map(([name, value]) =>
        sql`${
          identifier(`${table.name}.${physicalColumnName(table, name)}`)
        } = ${value}`
      ),
    );
    const parts: Sql[] = [];
    if (ctes !== undefined && ctes.length > 0) {
      parts.push(mutationWithPrefixSql("WITH … UPDATE", ctes));
    }
    parts.push(updateStatementHead(table, setSql, mysqlSetSql, from));

    if (condition === undefined) {
      assertUnsafeAllRowsAllowed("update", allowAllRows, table.name);
    } else {
      parts.push(raw(" where "), condition.sql);
    }

    const returningPart = returningSql(returning, table, "update");
    if (returningPart !== undefined) {
      if (from !== undefined) {
        parts.push(capabilityGuard(DIALECT_CAPABILITIES.updateFromReturning));
      }
      parts.push(returningPart);
    }

    return attachResultMetadata(
      joinSql(parts, emptySql()),
      returningResultMetadata(returning, table),
    );
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

/** Immutable state of a `DELETE` builder. */
interface DeleteState<TTable extends TableDefinition> {
  readonly table: TTable;
  readonly condition?: Condition;
  readonly allowAllRows: boolean;
  readonly returning: SelectProjection | boolean;
  /** CTEs prepended as a `WITH` (mutating terminal of `db.with(...)`). */
  readonly ctes?: readonly CteDefinition[];
  /** `DELETE … USING <source>` auxiliary relation (a table/CTE/subquery). */
  readonly using?: Sql;
}

export class SisalDeleteBuilder<TTable extends TableDefinition>
  implements DeleteBuilder<TTable> {
  readonly #database: Database;
  readonly #state: DeleteState<TTable>;

  constructor(database: Database, state: DeleteState<TTable>) {
    this.#database = database;
    this.#state = state;
  }

  #with(patch: Partial<DeleteState<TTable>>): SisalDeleteBuilder<TTable> {
    return new SisalDeleteBuilder<TTable>(this.#database, {
      ...this.#state,
      ...patch,
    });
  }

  using(source: SelectFromSource): DeleteBuilder<TTable> {
    return this.#with({
      using: mutationRelationSql(source),
    });
  }

  where(condition: Condition): DeleteBuilder<TTable> {
    assertCondition(condition);
    return this.#with({ condition });
  }

  unsafeAllowAllRows(): DeleteBuilder<TTable> {
    return this.#with({ allowAllRows: true });
  }

  returning(): DeleteBuilder<TTable, InferSelect<TTable>>;
  returning<TProjection extends SelectProjection>(
    projection: TProjection,
  ): DeleteBuilder<TTable, InferProjection<TProjection>>;
  returning(
    projection?: SelectProjection,
  ): DeleteBuilder<TTable, InferSelect<TTable>> {
    return this.#with({
      returning: projection ?? true,
    }) as unknown as DeleteBuilder<TTable, InferSelect<TTable>>;
  }

  returningColumnKeys(): readonly string[] {
    return mutationCteColumnKeys(
      this.#state.returning,
      this.#state.table,
      "delete",
    );
  }

  toSql(): Sql {
    const { table, condition, allowAllRows, returning, ctes, using } =
      this.#state;
    const parts: Sql[] = [];
    if (ctes !== undefined && ctes.length > 0) {
      parts.push(mutationWithPrefixSql("WITH … DELETE", ctes));
    }
    parts.push(deleteStatementHead(table, using));

    if (condition === undefined) {
      assertUnsafeAllRowsAllowed("delete", allowAllRows, table.name);
    } else {
      parts.push(raw(" where "), condition.sql);
    }

    const returningPart = returningSql(returning, table, "delete");
    if (returningPart !== undefined) {
      if (using !== undefined) {
        parts.push(capabilityGuard(DIALECT_CAPABILITIES.deleteUsingReturning));
      }
      parts.push(returningPart);
    }

    return attachResultMetadata(
      joinSql(parts, emptySql()),
      returningResultMetadata(returning, table),
    );
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

function updateStatementHead(
  table: TableDefinition,
  setSql: Sql,
  mysqlSetSql: Sql,
  from: Sql | undefined,
): Sql {
  if (from === undefined) {
    return sql`update ${identifier(table.name)} set ${setSql}`;
  }

  const portable = sql`update ${
    identifier(table.name)
  } set ${setSql} from ${from}`;
  const mysql = sql`update ${
    identifier(table.name)
  }, ${from} set ${mysqlSetSql}`;
  return dialectSql("UPDATE … FROM", { mysql }, portable);
}

function deleteStatementHead(
  table: TableDefinition,
  using: Sql | undefined,
): Sql {
  if (using === undefined) {
    return sql`delete from ${identifier(table.name)}`;
  }

  const portable = sql`${
    capabilityGuard(DIALECT_CAPABILITIES.deleteUsing)
  }delete from ${identifier(table.name)} using ${using}`;
  const mysql = sql`delete from ${identifier(table.name)} using ${
    identifier(table.name)
  }, ${using}`;
  return dialectSql("DELETE … USING", { mysql }, portable);
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
  rows: Array<InsertValues<TTable>>,
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
  values: UpdateValues<TTable>,
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
