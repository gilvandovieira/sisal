/**
 * The `Database` facade, the `OrmDriver` contract, and the built-in drivers.
 *
 * Part of the `@sisal/orm` core; re-exported through `./mod.ts`.
 */

import {
  type AnyTableDefinition,
  type ColumnDataType,
  type ColumnValueMode,
  type Condition,
  count,
  createSisalLogEmitter,
  type DialectIdentity,
  emptySql,
  type InferProjection,
  type InferSelect,
  isTable,
  type Logger,
  normalizeSqlInput,
  OrmError,
  renderSqlParametersForLog,
  type SelectColumnRef,
  type SelectProjection,
  type SisalLogCategory,
  type SisalLogEmitter,
  type SisalLoggingOptions,
  type Sql,
  type SqlDialect,
  type SqlInput,
  type SqlParameter,
  type SqlQuery,
  type TableDefinition,
  type TemporalParsingOptions,
} from "@sisal/core";
import {
  assertCondition,
  assertTable,
  cloneSqlQuery,
  decodeTemporalRow,
  getResultMetadata,
  type ResultColumnMetadata,
} from "@sisal/core/unstable-internal";
import {
  type Cte,
  CTE_DEFINITIONS,
  CTE_FROM_SOURCES,
  cteBodySql,
  type CteBuilder,
  cteColumnKeys,
  type CteCycleClause,
  type CteOperand,
  type CteSearchClause,
  type DeleteBuilder,
  type InsertBuilder,
  type RecursiveCteBuilder,
  type SelectBuilder,
  SisalDeleteBuilder,
  SisalInsertBuilder,
  SisalSelectBuilder,
  SisalUpdateBuilder,
  type UpdateBuilder,
  type WithQueryBuilder,
} from "./builders.ts";
import {
  createFunctionCall,
  type FunctionCall,
  type FunctionDefinition,
} from "./functions.ts";
import {
  createDatabaseQuery,
  createRelationRegistry,
  type RelationalTableQuery,
  type RelationRegistry,
  type RelationsList,
} from "./relations.ts";
import {
  type AdvisoryLock,
  type AdvisoryLockOptions,
  tryAcquireAdvisoryLock,
} from "./advisory_lock.ts";

export type { AdvisoryLock, AdvisoryLockOptions };

/** Result returned by ORM drivers and database execution methods. */
export interface OrmQueryResult<T = unknown> {
  /** Row count reported by this orm query result. */
  readonly rows: T[];
  /** Row count reported by this orm query result. */
  readonly rowCount?: number;
}

/** Async-first driver contract for future database adapters. */
export interface OrmDriver {
  /** Runs a query through this orm driver. */
  query<T = unknown>(
    query: SqlQuery,
  ): Promise<OrmQueryResult<T>>;
  /** Executes SQL through this orm driver. */

  execute(
    query: SqlQuery,
  ): Promise<OrmQueryResult>;

  /**
   * Runs `fn` inside one database transaction, committing on return and
   * rolling back on a throw. Optional in the contract, but a driver that
   * omits it cannot provide atomicity: {@link Database.transaction} (and
   * {@link Database.batch}, absent a native `batch`) then **throw**
   * `ORM_TRANSACTION_UNSUPPORTED` instead of silently running statements
   * non-atomically.
   */
  transaction?<T>(
    fn: (tx: OrmTransaction) => Promise<T>,
  ): Promise<T>;

  /**
   * Runs several pre-rendered statements as one atomic, non-interactive unit
   * (`begin; …; commit`). A driver may collapse this into a single round trip
   * where its client supports one; the built-in adapters run the statements
   * sequentially inside one transaction. Optional: when a driver omits it,
   * {@link Database.batch} falls back to {@link transaction}; when both are
   * missing, `Database.batch` throws rather than losing atomicity.
   */
  batch?(queries: readonly SqlQuery[]): Promise<OrmQueryResult[]>;
  /** Closes resources held by this orm driver. */

  close?(): Promise<void>;
}

/** Driver transaction facade exposed to transaction callbacks. */
export interface OrmTransaction {
  /** Executes SQL through this orm transaction. */
  query<T = unknown>(query: SqlQuery): Promise<OrmQueryResult<T>>;
  /** Executes SQL through this orm transaction. */
  execute(query: SqlQuery): Promise<OrmQueryResult>;
}

/**
 * Statement accepted by `Database.batch`: a query builder, `Sql` fragment, or
 * already-rendered `SqlQuery`.
 */
export type BatchStatement = { toSql(): Sql } | Sql | SqlQuery;

/** Schema map used to expose `db.query.<table>` relational helpers. */
export type DatabaseSchema = Record<string, AnyTableDefinition>;

/**
 * One column's mapping for `.as(map)`: the physical name to read from the raw
 * row plus the decode metadata. Every field is optional — a bare `{}` keeps the
 * key as-is and applies no decoding.
 */
export interface ColumnMapping {
  /** Physical column name in the raw result; defaults to the map key. */
  readonly name?: string;
  /** Column data type — drives Temporal decoding when parsing is enabled. */
  readonly dataType?: ColumnDataType;
  /** Value mode (`"date"`/`"string"`/…) — drives Temporal decoding. */
  readonly valueMode?: ColumnValueMode;
  /** Whether the column is an array (each element is decoded). */
  readonly array?: boolean;
}

/**
 * A free-form column-descriptor map for `.as(map)` — JS key → {@link
 * ColumnMapping} — for raw results that do not correspond to a single
 * `defineTable` (a join, an aggregate, a CTE projection).
 */
export type ColumnMap = Record<string, ColumnMapping>;

/**
 * The awaitable result of a raw `db.query(...)` call: a normal query-result
 * promise that also exposes `.as(...)`, which decodes the raw driver rows —
 * physical→JS column naming plus the same opt-in Temporal decoding the query
 * builder applies. Pass a `defineTable` model to get typed `InferSelect<table>`
 * rows, or a free-form {@link ColumnMap} for a result that does not match one
 * table (a join/aggregate/CTE projection). Lets a hand-written `sql` query reuse
 * existing column metadata instead of a restated row type.
 */
export interface MappableQueryResult<T = unknown>
  extends
    /** as for this mappable query result. */
    Promise<OrmQueryResult<T>> {
  /** as for this mappable query result. */
  as<TTable extends TableDefinition>(
    table: TTable,
    /** as for this mappable query result. */
  ): Promise<InferSelect<TTable>[]>;
  /** as for this mappable query result. */
  as<TRow = Record<string, unknown>>(map: ColumnMap): Promise<TRow[]>;
}

/** A raw SQL query executor. */
export interface RawQueryExecutor {
  <T = unknown>(
    query: SqlInput,
    params?: readonly SqlParameter[],
  ): MappableQueryResult<T>;
}

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
> /** dialect for this database. */ {
  /** dialect for this database. */
  readonly dialect: SqlDialect;
  /**
   * The full `(engine, variant, version)` identity queries render under.
   * `dialect` is always present; `variant`/`version` are set when the adapter
   * identified the server (e.g. MariaDB behind the `mysql` dialect), which is
   * what lets version-gated capabilities light up (see `dialectGuard`).
   */
  /** Runs a query through this database. */
  readonly dialectIdentity: DialectIdentity;
  /** Runs a query through this database. */
  readonly query: DatabaseQuery<TSchema, TRelations>;
  /** Executes SQL through this database. */

  execute<T = unknown>(
    query: SqlInput,
    params?: readonly SqlParameter[],
  ): Promise<OrmQueryResult<T>>;
  /** Select clause or selection produced by this database. */
  select(): SelectBuilder<unknown, unknown>;
  /** Starts a select builder with an explicit projection. */
  select<TProjection extends SelectProjection>(
    projection: TProjection,
  ): SelectBuilder<unknown, InferProjection<TProjection>>;

  /** Names a common table expression; complete it with `.as(query)`. */
  $with(name: string): CteBuilder;
  /**
   * Names a recursive common table expression with an explicit column list;
   * complete it with `.as((self) => base.unionAll(step))`. Renders
   * `WITH RECURSIVE name (columns) AS (…)` (one `RECURSIVE` keyword covers
   * mixed plain/recursive `WITH` lists).
   */
  $withRecursive<TColumn extends string>(
    name: string,
    columns: readonly TColumn[],
  ): RecursiveCteBuilder<TColumn>;
  /** Begins a query whose `WITH` clause provides the given CTEs. */
  with(...ctes: Cte[]): WithQueryBuilder;

  /** Counts rows in a table, optionally filtered, returning a `number`. */
  $count(table: TableDefinition, where?: Condition): Promise<number>;

  /**
   * Calls a typed database function declared with `defineFunction`, returning a
   * caller that renders one `SELECT * FROM fn(args)` statement (casts taken from
   * the argument column types) and runs it via `.execute()` / `.one()`.
   */
  call<TArgsInput, TRow>(
    fn: FunctionDefinition<TArgsInput, TRow>,
    args: TArgsInput,
  ): FunctionCall<TRow>;
  /** insert for this database. */

  insert<TTable extends TableDefinition>(
    table: TTable,
  ): InsertBuilder<TTable>;
  /** update for this database. */

  update<TTable extends TableDefinition>(
    table: TTable,
  ): UpdateBuilder<TTable>;
  /** delete for this database. */

  delete<TTable extends TableDefinition>(
    table: TTable,
  ): DeleteBuilder<TTable>;

  /**
   * Runs `fn` against a transaction-scoped facade: the callback's statements
   * commit together and roll back together. Requires driver transaction
   * support — a driver without it makes this throw
   * `ORM_TRANSACTION_UNSUPPORTED` instead of silently running the callback
   * non-atomically. Inside a transaction callback, a nested `transaction()`
   * joins the enclosing transaction.
   */
  transaction<T>(
    fn: (tx: Database<TSchema, TRelations>) => Promise<T>,
  ): Promise<T>;

  /**
   * Runs several pre-built statements as one atomic, **non-interactive**
   * transaction — ideal for Deno Deploy / Neon HTTP, where an interactive
   * `transaction()` callback holds a connection open. Each statement is a query
   * builder, a `` sql`...` `` fragment, or rendered SQL; they commit together and
   * roll back on any failure, returning one result per statement. No statement
   * may depend on a previous one's result (that is what `transaction()` and
   * database functions are for). Atomicity is guaranteed: a driver with
   * neither `batch` nor `transaction` support makes this throw
   * `ORM_TRANSACTION_UNSUPPORTED` instead of running statements sequentially.
   */
  batch(statements: readonly BatchStatement[]): Promise<OrmQueryResult[]>;

  /**
   * Tries to claim a portable, **lightweight** advisory lock named `name` — a
   * coarse whole-job mutual-exclusion primitive (the v0.6 A2 / contract-08
   * substrate a future ETL runner uses so two runs never process the same
   * window twice). Non-blocking: it returns immediately whether or not the lock
   * was won. Backed by a `sisal_advisory_locks` lease row, so **no connection
   * or server-side lock is held** between acquire and release — work proceeds on
   * the normal pool. Always `await using` the result so the lease is released on
   * scope exit, including on an early return or a throw:
   *
   * ```ts
   * await using lock = await db.tryAdvisoryLock(`sisal:etl:${job}`);
   * if (!lock.acquired) return; // another runner holds it
   * await runWindow(db);
   * ```
   *
   * A crashed holder's lease expires after `ttlMs` (default 30s), after which
   * another claimant may steal it; long runs should call `lock.renew()` and stop
   * on a `false`. The lease rows live in `sisal_advisory_locks` by default;
   * pass `{ table }` to place them under your own name. Throws
   * `ORM_DIALECT_UNSUPPORTED` on the `generic` dialect.
   */
  tryAdvisoryLock(
    name: string,
    options?: AdvisoryLockOptions,
  ): Promise<AdvisoryLock>;
  /** Closes resources held by this database. */

  close(): Promise<void>;

  /**
   * Async-disposal alias for {@link close}, so
   * `await using db = await connect(...)` releases the driver's connection or
   * pool when the scope exits — including on an early return or a throw.
   */
  [Symbol.asyncDispose](): Promise<void>;
}

/** Options for creating a {@link Database}. */
export interface DatabaseOptions<
  TSchema extends DatabaseSchema = Record<never, AnyTableDefinition>,
  TRelations extends RelationsList = readonly [],
> /** Driver used by this database options. */ {
  /** dialect for this database options. */
  readonly driver?: OrmDriver;
  /** dialect for this database options. */
  readonly dialect?: SqlDialect;
  /** Engine variant behind the dialect (e.g. `"mariadb"`); see {@link DialectIdentity}. */
  readonly variant?: string;
  /** Server version string; see {@link DialectIdentity}. */
  readonly version?: string;
  /** Logging options used by this database options. */
  readonly logger?: Logger;
  /** Logging options used by this database options. */
  readonly logging?: SisalLoggingOptions;
  /** Optional schema map that enables `db.query.<schemaKey>`. */
  readonly schema?: TSchema;
  /** Relation definitions created with {@link relations}. */
  readonly relations?: TRelations;
  /** Opt-in Temporal result parsing for ORM-built queries with column metadata. */
  readonly temporal?: TemporalParsingOptions;
}

/** Options for the in-memory ORM driver. */
export interface MemoryOrmDriverOptions {
  /** tables for this memory orm driver options. */
  readonly tables?: Record<string, Array<Record<string, unknown>>>;
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
    ...(options.variant === undefined ? {} : { variant: options.variant }),
    ...(options.version === undefined ? {} : { version: options.version }),
    logger: options.logger,
    ...(options.logging === undefined ? {} : { logging: options.logging }),
    ...(options.schema === undefined ? {} : { schema: options.schema }),
    ...(options.relations === undefined
      ? {}
      : { relations: options.relations }),
    ...(options.temporal === undefined ? {} : { temporal: options.temporal }),
  });
}

/**
 * Creates a driver that never touches a real database.
 *
 * Useful for tests and scaffolding; it always returns empty result sets.
 */
export function noopOrmDriver(): OrmDriver {
  const driver: OrmDriver = {
    query<T = unknown>(_query: SqlQuery): Promise<OrmQueryResult<T>> {
      return Promise.resolve({ rows: [], rowCount: 0 });
    },

    execute(_query: SqlQuery): Promise<OrmQueryResult> {
      return Promise.resolve({ rows: [], rowCount: 0 });
    },

    transaction<T>(fn: (tx: OrmTransaction) => Promise<T>): Promise<T> {
      return fn(driver);
    },

    close(): Promise<void> {
      return Promise.resolve();
    },
  };

  return driver;
}

/** Creates a tiny in-memory driver that records no data and returns empty rows. */
export function memoryOrmDriver(
  _options: MemoryOrmDriverOptions = {},
): OrmDriver {
  const history: SqlQuery[] = [];

  const driver: OrmDriver = {
    query<T = unknown>(query: SqlQuery): Promise<OrmQueryResult<T>> {
      history.push(cloneSqlQuery(query));
      return Promise.resolve({ rows: [], rowCount: 0 });
    },

    execute(query: SqlQuery): Promise<OrmQueryResult> {
      history.push(cloneSqlQuery(query));
      return Promise.resolve({ rows: [], rowCount: 0 });
    },

    transaction<T>(fn: (tx: OrmTransaction) => Promise<T>): Promise<T> {
      return fn(driver);
    },

    close(): Promise<void> {
      history.length = 0;
      return Promise.resolve();
    },
  };

  return driver;
}

interface SisalDatabaseOptions<
  TSchema extends DatabaseSchema,
  TRelations extends RelationsList,
> {
  readonly driver: OrmDriver;
  readonly dialect: SqlDialect;
  readonly variant?: string;
  readonly version?: string;
  readonly logger?: Logger;
  readonly logging?: SisalLoggingOptions;
  readonly log?: SisalLogEmitter;
  readonly schema?: TSchema;
  readonly relations?: TRelations;
  readonly temporal?: TemporalParsingOptions;
}

class SisalDatabase<
  TSchema extends DatabaseSchema = Record<never, AnyTableDefinition>,
  TRelations extends RelationsList = readonly [],
> implements Database<TSchema, TRelations> {
  readonly dialect: SqlDialect;
  readonly dialectIdentity: DialectIdentity;
  readonly query: DatabaseQuery<TSchema, TRelations>;
  readonly #driver: OrmDriver;
  readonly #log: SisalLogEmitter;
  readonly #schema?: TSchema;
  readonly #relations?: TRelations;
  readonly #temporal: TemporalParsingOptions;
  readonly #relationRegistry: RelationRegistry;

  constructor(options: SisalDatabaseOptions<TSchema, TRelations>) {
    this.#driver = options.driver;
    this.dialect = options.dialect;
    this.dialectIdentity = {
      dialect: options.dialect,
      ...(options.variant === undefined ? {} : { variant: options.variant }),
      ...(options.version === undefined ? {} : { version: options.version }),
    };
    this.#log = options.log ?? createSisalLogEmitter({
      logger: options.logger,
      logging: options.logging,
      defaultLevel: "debug",
      metadata: options.logging !== undefined,
    });
    this.#schema = options.schema;
    this.#relations = options.relations;
    this.#temporal = options.temporal ?? {};
    this.#relationRegistry = createRelationRegistry(options.relations ?? []);
    this.query = createDatabaseQuery<TSchema, TRelations>(
      (query, params) => this.#mappableQuery(query, params),
      this,
      this.#schema,
      this.#relationRegistry,
    );
  }

  // Wraps a raw query promise with `.as(...)` so its rows can be decoded against
  // a table model or a free-form column map (physical→JS naming + opt-in
  // Temporal parsing).
  #mappableQuery<T>(
    query: SqlInput,
    params?: readonly SqlParameter[],
  ): MappableQueryResult<T> {
    const promise = this.#query<T>(query, params) as MappableQueryResult<T>;
    const as = (source: TableDefinition | ColumnMap) => {
      if (!isTable(source) && (typeof source !== "object" || source === null)) {
        throw new OrmError("Expected a table definition or column map", {
          code: "ORM_INVALID_TABLE",
        });
      }
      return promise.then((result) =>
        this.#mapRows(result.rows as Record<string, unknown>[], source)
      );
    };
    promise.as = as as MappableQueryResult<T>["as"];
    return promise;
  }

  // Maps raw driver rows onto a table model or column map: renames physical
  // column names to their JS keys, then applies the same opt-in Temporal
  // decoding the builder uses. Unknown keys pass through untouched.
  #mapRows(
    rows: readonly Record<string, unknown>[],
    source: TableDefinition | ColumnMap,
  ): Record<string, unknown>[] {
    const rename: Record<string, string> = {};
    const metadata: Record<string, ResultColumnMetadata> = {};
    if (isTable(source)) {
      for (const [property, column] of Object.entries(source.columns)) {
        rename[column.name] = property;
        metadata[property] = column;
      }
    } else {
      for (const [key, descriptor] of Object.entries(source)) {
        rename[descriptor.name ?? key] = key;
        metadata[key] = {
          array: descriptor.array,
          dataType: descriptor.dataType,
          valueMode: descriptor.valueMode,
        } as ResultColumnMetadata;
      }
    }
    const parse = this.#temporal.parse === true;
    return rows.map((row) => {
      const mapped: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        mapped[rename[key] ?? key] = value;
      }
      return parse ? decodeTemporalRow(mapped, metadata) : mapped;
    });
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

  $with(name: string): CteBuilder {
    return {
      as: <TResult>(
        query: CteOperand<TResult>,
      ): Cte<{ readonly [K in keyof TResult]-?: SelectColumnRef }> => {
        const columns: Record<string, SelectColumnRef> = {};
        for (const key of cteColumnKeys(query)) {
          columns[key] = {
            name: key,
            tableName: name,
            dataType: "unknown",
          } as unknown as SelectColumnRef;
        }
        CTE_DEFINITIONS.set(columns, { name, query: cteBodySql(query) });
        return columns as Cte<
          { readonly [K in keyof TResult]-?: SelectColumnRef }
        >;
      },
    };
  }

  $withRecursive<TColumn extends string>(
    name: string,
    columnNames: readonly TColumn[],
  ): RecursiveCteBuilder<TColumn> {
    if (columnNames.length === 0) {
      throw new OrmError(
        "$withRecursive requires an explicit, non-empty column list",
        { code: "ORM_INVALID_QUERY" },
      );
    }
    return makeRecursiveCteBuilder<TColumn, never>(name, columnNames, {});
  }

  with(...ctes: Cte[]): WithQueryBuilder {
    const definitions = ctes.map((cte) => {
      const definition = CTE_DEFINITIONS.get(cte);
      if (definition === undefined) {
        throw new OrmError(
          "with() expects CTEs created via db.$with(name).as(query)",
          { code: "ORM_INVALID_QUERY" },
        );
      }
      return definition;
    });
    // deno-lint-ignore no-this-alias
    const database: Database = this;
    return {
      select: (
        projection?: SelectProjection,
      ): SelectBuilder<unknown, unknown> =>
        new SisalSelectBuilder<unknown, unknown>(database, {
          joins: [],
          ctes: definitions,
          ...(projection === undefined ? {} : { projection }),
        }),
      insert: <TTable extends TableDefinition>(
        table: TTable,
      ): InsertBuilder<TTable> => {
        assertTable(table);
        return new SisalInsertBuilder(database, {
          table,
          returning: false,
          ctes: definitions,
        });
      },
      update: <TTable extends TableDefinition>(
        table: TTable,
      ): UpdateBuilder<TTable> => {
        assertTable(table);
        return new SisalUpdateBuilder(database, {
          table,
          allowAllRows: false,
          returning: false,
          ctes: definitions,
        });
      },
      delete: <TTable extends TableDefinition>(
        table: TTable,
      ): DeleteBuilder<TTable> => {
        assertTable(table);
        return new SisalDeleteBuilder(database, {
          table,
          allowAllRows: false,
          returning: false,
          ctes: definitions,
        });
      },
    } as WithQueryBuilder;
  }

  call<TArgsInput, TRow>(
    fn: FunctionDefinition<TArgsInput, TRow>,
    args: TArgsInput,
  ): FunctionCall<TRow> {
    return createFunctionCall<TRow>(this, fn, args);
  }

  async $count(table: TableDefinition, where?: Condition): Promise<number> {
    assertTable(table);
    let builder = this.select({ count: count() }).from(table);
    if (where !== undefined) {
      assertCondition(where);
      builder = builder.where(where);
    }
    const rows = await builder.execute();
    const value = (rows[0] as { count?: unknown } | undefined)?.count;
    return typeof value === "bigint" ? Number(value) : Number(value ?? 0);
  }

  insert<TTable extends TableDefinition>(
    table: TTable,
  ): InsertBuilder<TTable> {
    assertTable(table);
    return new SisalInsertBuilder(this, { table, returning: false });
  }

  update<TTable extends TableDefinition>(
    table: TTable,
  ): UpdateBuilder<TTable> {
    assertTable(table);
    return new SisalUpdateBuilder(this, {
      table,
      allowAllRows: false,
      returning: false,
    });
  }

  delete<TTable extends TableDefinition>(
    table: TTable,
  ): DeleteBuilder<TTable> {
    assertTable(table);
    return new SisalDeleteBuilder(this, {
      table,
      allowAllRows: false,
      returning: false,
    });
  }

  async transaction<T>(
    fn: (tx: Database<TSchema, TRelations>) => Promise<T>,
  ): Promise<T> {
    // Fail closed: silently running the callback outside a transaction would
    // discard the atomicity the caller asked for.
    if (this.#driver.transaction === undefined) {
      throw new OrmError("Driver does not support transactions", {
        code: "ORM_TRANSACTION_UNSUPPORTED",
      });
    }

    const timed = this.#log.settings.metadata &&
      this.#log.enabled("debug", "orm.transaction");
    const startedAt = timed ? performance.now() : 0;
    if (timed) {
      this.#debug("orm.transaction", undefined, "orm transaction started");
    }

    try {
      const result = await this.#driver.transaction(async (tx) => {
        const transactionDatabase = new SisalDatabase<TSchema, TRelations>({
          driver: transactionToDriver(tx),
          dialect: this.dialect,
          ...(this.dialectIdentity.variant === undefined
            ? {}
            : { variant: this.dialectIdentity.variant }),
          ...(this.dialectIdentity.version === undefined
            ? {}
            : { version: this.dialectIdentity.version }),
          log: this.#log,
          ...(this.#schema === undefined ? {} : { schema: this.#schema }),
          ...(this.#relations === undefined
            ? {}
            : { relations: this.#relations }),
          temporal: this.#temporal,
        });

        return await fn(transactionDatabase);
      });

      if (timed) {
        this.#debug(
          "orm.transaction",
          { durationMs: elapsedMs(startedAt) },
          "orm transaction completed",
        );
      }
      return result;
    } catch (error) {
      if (
        this.#log.settings.metadata &&
        this.#log.enabled("error", "orm.transaction")
      ) {
        this.#error("orm.transaction", undefined, "orm transaction failed");
      }
      throw new OrmError("ORM transaction failed", {
        code: "ORM_TRANSACTION_FAILED",
        cause: error,
      });
    }
  }

  async batch(
    statements: readonly BatchStatement[],
  ): Promise<OrmQueryResult[]> {
    // Render first: an unbound placeholder throws a clear OrmError here, before
    // anything touches the database.
    const queries = statements.map((statement) =>
      this.#renderBatchStatement(statement)
    );
    if (queries.length === 0) {
      return [];
    }

    const timed = this.#log.enabled("debug", "orm.batch");
    const startedAt = timed ? performance.now() : 0;
    if (timed) {
      this.#debug(
        "orm.batch",
        { statements: queries.length },
        "orm batch started",
      );
    }

    try {
      const results = await this.#runBatch(queries);
      if (timed) {
        this.#debug(
          "orm.batch",
          { statements: queries.length, durationMs: elapsedMs(startedAt) },
          "orm batch completed",
        );
      }
      return results;
    } catch (error) {
      if (this.#log.enabled("error", "orm.batch")) {
        this.#error(
          "orm.batch",
          { statements: queries.length },
          "orm batch failed",
        );
      }
      if (error instanceof OrmError) {
        throw error;
      }
      throw new OrmError("ORM batch failed", {
        code: "ORM_BATCH_FAILED",
        cause: error,
      });
    }
  }

  #renderBatchStatement(statement: BatchStatement): SqlQuery {
    const input = typeof (statement as { toSql?: unknown }).toSql === "function"
      ? (statement as { toSql(): Sql }).toSql()
      : (statement as SqlInput);
    return normalizeSqlInput(input, undefined, this.dialectIdentity);
  }

  async #runBatch(queries: SqlQuery[]): Promise<OrmQueryResult[]> {
    // Prefer a driver's own batch: it may collapse the statements into a single
    // round trip where the client supports one, though the built-in adapters run
    // them sequentially inside one transaction.
    if (this.#driver.batch !== undefined) {
      return await this.#driver.batch(queries);
    }
    // Otherwise wrap the statements in one atomic transaction.
    if (this.#driver.transaction !== undefined) {
      return await this.#driver.transaction(async (tx) => {
        const results: OrmQueryResult[] = [];
        for (const query of queries) {
          results.push(await tx.execute(query));
        }
        return results;
      });
    }
    // Fail closed: running the statements sequentially would silently drop
    // the commit-together/roll-back-together contract of db.batch.
    throw new OrmError(
      "Driver supports neither batch nor transactions; db.batch requires an atomic unit",
      { code: "ORM_TRANSACTION_UNSUPPORTED" },
    );
  }

  tryAdvisoryLock(
    name: string,
    options?: AdvisoryLockOptions,
  ): Promise<AdvisoryLock> {
    return tryAcquireAdvisoryLock(this, name, options);
  }

  async close(): Promise<void> {
    await this.#driver.close?.();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  async #run<T>(
    operation: "query" | "execute",
    query: SqlInput,
    params: readonly SqlParameter[] | undefined,
    run: (rendered: SqlQuery) => Promise<OrmQueryResult<T>>,
  ): Promise<OrmQueryResult<T>> {
    const rendered = normalizeSqlInput(query, params, this.dialectIdentity);

    // Every branch is guarded by `enabled(...)` first so that with no logger
    // attached (or the level/category gated off) this hot path allocates
    // nothing — no record objects, no `performance.now()`, no parameter
    // rendering. That keeps logging free for callers who never opt in.
    if (this.#log.enabled("debug", "orm.sql")) {
      this.#debug("orm.sql", { sql: rendered.text }, "orm query started");
    }
    // `metadata` gates the bind category behind opting into the structured
    // logging config (legacy bare-`logger` callers never get it); the
    // `parameters` mode chooses raw values vs. redacted summaries, and `off`
    // skips the category entirely.
    if (
      rendered.params.length > 0 &&
      this.#log.settings.sql.parameters !== "off" &&
      this.#log.settings.metadata &&
      this.#log.enabled("trace", "orm.bind")
    ) {
      this.#trace(
        "orm.bind",
        {
          params: renderSqlParametersForLog(
            rendered.params,
            this.#log.settings.sql.parameters,
          ),
        },
        "orm query parameters",
      );
    }

    const resultEnabled = this.#log.enabled("debug", "orm.result");
    const startedAt = resultEnabled ? performance.now() : 0;

    try {
      const result = await run(rendered);
      if (resultEnabled) {
        this.#debug(
          "orm.result",
          {
            rowCount: result.rowCount ?? result.rows.length,
            durationMs: elapsedMs(startedAt),
          },
          "orm query completed",
        );
      }
      return this.#decodeResult(rendered, result);
    } catch (error) {
      if (this.#log.enabled("error", "orm.query")) {
        this.#error("orm.query", { sql: rendered.text }, "orm query failed");
      }

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

  #trace(
    category: SisalLogCategory,
    record: Record<string, unknown>,
    message: string,
  ): void {
    this.#log.emit({ level: "trace", category, record, message });
  }

  #debug(
    category: SisalLogCategory,
    record: Record<string, unknown> | undefined,
    message: string,
  ): void {
    this.#log.emit({ level: "debug", category, record, message });
  }

  #error(
    category: SisalLogCategory,
    record: Record<string, unknown> | undefined,
    message: string,
  ): void {
    this.#log.emit({ level: "error", category, record, message });
  }

  #decodeResult<T>(
    query: SqlQuery,
    result: OrmQueryResult<T>,
  ): OrmQueryResult<T> {
    if (this.#temporal.parse !== true) {
      return result;
    }
    const metadata = getResultMetadata(query);
    if (metadata === undefined || Object.keys(metadata).length === 0) {
      return result;
    }
    return {
      rows: result.rows.map((row) =>
        decodeTemporalRow(row as Record<string, unknown>, metadata) as T
      ),
      rowCount: result.rowCount,
    };
  }
}

function transactionToDriver(transaction: OrmTransaction): OrmDriver {
  const driver: OrmDriver = {
    query<T = unknown>(query: SqlQuery): Promise<OrmQueryResult<T>> {
      return transaction.query<T>(query);
    },

    execute(query: SqlQuery): Promise<OrmQueryResult> {
      return transaction.execute(query);
    },

    // A transaction facade cannot open a new driver-level transaction; a
    // nested transaction() (or batch()) joins the enclosing one and commits
    // or rolls back with it.
    transaction<T>(fn: (tx: OrmTransaction) => Promise<T>): Promise<T> {
      return fn(driver);
    },
  };

  return driver;
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt);
}

/**
 * A portable atomic operation — a "transaction script". Author dependent
 * read-modify-write steps once; {@link AtomicOperation.run} executes them as a
 * single transaction on any adapter (`@sisal/pg`, `@sisal/neon`,
 * `@sisal/sqlite`, `@sisal/libsql`), replacing per-engine hand-written
 * transaction/function code with one definition.
 */
export interface AtomicOperation<TInput, TOutput> {
  /** Stable operation name (used by tooling and future function dispatch). */
  readonly name: string;
  /**
   * Runs the operation against `db` inside one `db.transaction(...)` — the steps
   * commit together and roll back on any error — returning the body's result.
   */
  run(db: Database, input: TInput): Promise<TOutput>;
}

/** The interactive form of an atomic operation — runs on every adapter. */
export type AtomicOperationBody<TInput, TOutput> = (
  tx: Database,
  input: TInput,
) => Promise<TOutput>;

/**
 * An atomic operation with two render strategies behind one definition. `body`
 * is the portable interactive transaction (required, runs everywhere).
 * `singleStatement` is an optional **single-round-trip** path for the
 * Postgres family: build the same logic as one data-modifying CTE (item 12) and
 * execute it with one `db.execute` — no `BEGIN`/`COMMIT`, ideal for Neon HTTP /
 * Deno Deploy. `run` picks the single statement on `"postgres"` when present and
 * the interactive `body` everywhere else, so callers invoke `op.run(db, input)`
 * the same way on every engine.
 */
export interface AtomicOperationConfig<TInput, TOutput> {
  /** Interactive implementation that runs on every adapter. */
  readonly body: AtomicOperationBody<TInput, TOutput>;
  /** Optional single-statement implementation for adapters that support it. */
  readonly singleStatement?: (
    db: Database,
    input: TInput,
  ) => Promise<TOutput>;
}

/**
 * Defines an {@link AtomicOperation}. Pass a transaction-scoped body — which may
 * run dependent steps (a read that drives a later write) — or an
 * {@link AtomicOperationConfig} with both a portable `body` and an optional
 * Postgres-family `singleStatement` path. The same operation runs identically
 * from the caller's side on every adapter, so application code is shaped by the
 * domain, not the engine: `op.run(db, input)` is one round trip on Neon (when a
 * `singleStatement` is given) and one interactive transaction on libSQL.
 *
 * @example
 * const recordVote = defineAtomicOperation<{ postId: number }, number>(
 *   "record_vote",
 *   {
 *     // Portable: read-modify-write inside one interactive transaction.
 *     body: async (tx, { postId }) => {
 *       const [post] = await tx.select({ v: posts.columns.votes }).from(posts)
 *         .where(eq(posts.columns.id, postId)).execute();
 *       const next = Number(post.v) + 1;
 *       await tx.update(posts).set({ votes: next })
 *         .where(eq(posts.columns.id, postId)).execute();
 *       return next;
 *     },
 *     // Postgres family: the same effect as one data-modifying CTE statement.
 *     singleStatement: async (db, { postId }) => {
 *       const bumped = db.$with("bumped").as(
 *         db.update(posts).set({ votes: sql`${posts.columns.votes} + 1` })
 *           .where(eq(posts.columns.id, postId))
 *           .returning({ v: posts.columns.votes }),
 *       );
 *       const [row] = await db.with(bumped).select({ v: bumped.v })
 *         .from(bumped).execute();
 *       return Number(row.v);
 *     },
 *   },
 * );
 * const votes = await recordVote.run(db, { postId: 1 });
 */
export function defineAtomicOperation<TInput, TOutput>(
  name: string,
  bodyOrConfig:
    | AtomicOperationBody<TInput, TOutput>
    | AtomicOperationConfig<TInput, TOutput>,
): AtomicOperation<TInput, TOutput> {
  const config: AtomicOperationConfig<TInput, TOutput> =
    typeof bodyOrConfig === "function" ? { body: bodyOrConfig } : bodyOrConfig;
  return Object.freeze({
    name,
    run(db: Database, input: TInput): Promise<TOutput> {
      // A single data-modifying CTE is atomic on its own; the Postgres family
      // runs it as one round trip. Every other engine runs the interactive form.
      if (config.singleStatement !== undefined && db.dialect === "postgres") {
        return config.singleStatement(db, input);
      }
      return db.transaction((tx) => config.body(tx, input));
    },
  });
}

/** Pending PostgreSQL-only clauses accumulated by a recursive CTE builder. */
interface RecursiveCteClauses {
  readonly search?: CteSearchClause;
  readonly cycle?: CteCycleClause;
}

// The immutable builder behind `db.$withRecursive`: each SEARCH/CYCLE call
// validates against the declared column list and returns a new builder;
// `.as()` registers the definition (clauses included) and — when clauses added
// output columns — returns a widened CTE reference carrying them.
function makeRecursiveCteBuilder<
  TColumn extends string,
  TExtra extends string,
>(
  name: string,
  columnNames: readonly TColumn[],
  clauses: RecursiveCteClauses,
): RecursiveCteBuilder<TColumn, TExtra> {
  // Every name already claimed by the CTE: declared columns plus the output
  // columns of previously added clauses. New SET/USING names must be fresh —
  // PostgreSQL rejects collisions with its own error, but failing at
  // definition time keeps the mistake near its source.
  const claimedNames = (): Set<string> => {
    const names = new Set<string>(columnNames);
    if (clauses.search !== undefined) {
      names.add(clauses.search.set);
    }
    if (clauses.cycle !== undefined) {
      names.add(clauses.cycle.set);
      names.add(clauses.cycle.using);
    }
    return names;
  };

  const assertByColumns = (
    by: readonly string[],
    clause: string,
  ): readonly string[] => {
    if (by.length === 0) {
      throw new OrmError(
        `recursive CTE "${name}": ${clause} requires at least one BY column`,
        { code: "ORM_INVALID_QUERY" },
      );
    }
    for (const column of by) {
      if (!(columnNames as readonly string[]).includes(column)) {
        throw new OrmError(
          `recursive CTE "${name}": ${clause} BY column "${column}" is not ` +
            `in the declared column list (${columnNames.join(", ")})`,
          { code: "ORM_INVALID_QUERY" },
        );
      }
    }
    return [...by];
  };

  const assertFreshName = (
    column: string,
    label: string,
    taken: Set<string>,
  ): string => {
    if (typeof column !== "string" || column.trim().length === 0) {
      throw new OrmError(
        `recursive CTE "${name}": ${label} requires a non-empty column name`,
        { code: "ORM_INVALID_QUERY" },
      );
    }
    if (taken.has(column)) {
      throw new OrmError(
        `recursive CTE "${name}": ${label} column "${column}" collides with ` +
          `a declared or clause-set column`,
        { code: "ORM_INVALID_QUERY" },
      );
    }
    return column;
  };

  const addSearch = (
    order: "depth" | "breadth",
    by: readonly TColumn[],
    set: string,
  ): RecursiveCteClauses => {
    if (clauses.search !== undefined) {
      throw new OrmError(
        `recursive CTE "${name}" already declares a SEARCH clause`,
        { code: "ORM_INVALID_QUERY" },
      );
    }
    const clause = `SEARCH ${order.toUpperCase()} FIRST`;
    return {
      ...clauses,
      search: {
        order,
        by: assertByColumns(by, clause),
        set: assertFreshName(set, `${clause} SET`, claimedNames()),
      },
    };
  };

  return {
    searchDepthFirst: (by, set) =>
      makeRecursiveCteBuilder(name, columnNames, addSearch("depth", by, set)),
    searchBreadthFirst: (by, set) =>
      makeRecursiveCteBuilder(name, columnNames, addSearch("breadth", by, set)),
    cycle: (by, set, using) => {
      if (clauses.cycle !== undefined) {
        throw new OrmError(
          `recursive CTE "${name}" already declares a CYCLE clause`,
          { code: "ORM_INVALID_QUERY" },
        );
      }
      const taken = claimedNames();
      const setName = assertFreshName(set, "CYCLE SET", taken);
      taken.add(setName);
      return makeRecursiveCteBuilder(name, columnNames, {
        ...clauses,
        cycle: {
          by: assertByColumns(by, "CYCLE"),
          set: setName,
          using: assertFreshName(using, "CYCLE USING", taken),
        },
      });
    },
    as: <TResult>(
      build: (
        self: Cte<{ readonly [K in TColumn]: SelectColumnRef }>,
      ) => CteOperand<TResult>,
    ): Cte<{ readonly [K in TColumn | TExtra]: SelectColumnRef }> => {
      // The self-reference exists before the body: its columns are the
      // declared list, and its definition is filled in after the callback
      // builds the body (the WeakMap entry is shared by reference).
      const columns: Record<string, SelectColumnRef> = {};
      for (const key of columnNames) {
        columns[key] = {
          name: key,
          tableName: name,
          dataType: "unknown",
        } as unknown as SelectColumnRef;
      }
      // Register the reference first so `from(self)` works inside `build`.
      CTE_DEFINITIONS.set(columns, {
        name,
        query: emptySql(),
        recursive: true,
        columnNames,
      });
      const self = columns as Cte<
        { readonly [K in TColumn]: SelectColumnRef }
      >;
      const body = build(self);
      // Guard: the recursive step must reference the self-reference in its
      // FROM (via `from(self)`). Referencing it only in SELECT/WHERE renders a
      // step whose FROM omits the CTE — invalid recursive SQL on every engine.
      if (!CTE_FROM_SOURCES.has(columns)) {
        throw new OrmError(
          `recursive CTE "${name}" never uses its self-reference as a FROM ` +
            `source — call \`from(self)\` in the recursive step (referencing ` +
            `\`self\` only in SELECT/WHERE renders SQL where the CTE is ` +
            `absent from the FROM clause)`,
          { code: "ORM_INVALID_QUERY" },
        );
      }
      const definition = {
        name,
        query: cteBodySql(body),
        recursive: true,
        columnNames,
        ...(clauses.search === undefined ? {} : { search: clauses.search }),
        ...(clauses.cycle === undefined ? {} : { cycle: clauses.cycle }),
      };
      CTE_DEFINITIONS.set(columns, definition);
      if (clauses.search === undefined && clauses.cycle === undefined) {
        return self as Cte<
          { readonly [K in TColumn | TExtra]: SelectColumnRef }
        >;
      }
      // SEARCH/CYCLE output columns are visible OUTSIDE the CTE only (the
      // standard forbids referencing them in the recursive body), so the
      // returned reference is a widened copy; `self` stays narrow.
      const widened: Record<string, SelectColumnRef> = { ...columns };
      const extras = [
        clauses.search?.set,
        clauses.cycle?.set,
        clauses.cycle?.using,
      ].filter((column): column is string => column !== undefined);
      for (const key of extras) {
        widened[key] = {
          name: key,
          tableName: name,
          dataType: "unknown",
        } as unknown as SelectColumnRef;
      }
      CTE_DEFINITIONS.set(widened, definition);
      return widened as Cte<
        { readonly [K in TColumn | TExtra]: SelectColumnRef }
      >;
    },
  };
}
