/**
 * The `Database` facade, the `OrmDriver` contract, and the built-in drivers.
 *
 * Part of the `@sisal/orm` core; re-exported through `./mod.ts`.
 */

import type { Logger } from "../logger.ts";
import {
  type Cte,
  CTE_DEFINITIONS,
  cteBodySql,
  type CteBuilder,
  cteColumnKeys,
  type CteOperand,
  type DeleteBuilder,
  type InsertBuilder,
  type SelectBuilder,
  SisalDeleteBuilder,
  SisalInsertBuilder,
  SisalSelectBuilder,
  SisalUpdateBuilder,
  type UpdateBuilder,
  type WithQueryBuilder,
} from "./builders.ts";
import { OrmError } from "./errors.ts";
import {
  createFunctionCall,
  type FunctionCall,
  type FunctionDefinition,
} from "./functions.ts";
import { count } from "./operators.ts";
import {
  createDatabaseQuery,
  createRelationRegistry,
  type RelationalTableQuery,
  type RelationRegistry,
  type RelationsList,
} from "./relations.ts";
import {
  assertCondition,
  cloneSqlQuery,
  type Condition,
  getResultMetadata,
  type InferProjection,
  normalizeSqlInput,
  type SelectColumnRef,
  type SelectProjection,
  type Sql,
  type SqlDialect,
  type SqlInput,
  type SqlParameter,
  type SqlQuery,
} from "./sql.ts";
import {
  type AnyTableDefinition,
  assertTable,
  type InferSelect,
  type TableDefinition,
} from "./table.ts";
import {
  decodeTemporalRow,
  type ResultColumnMetadata,
  type TemporalParsingOptions,
} from "./temporal.ts";

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

  /**
   * Runs several pre-rendered statements as one atomic, non-interactive unit
   * (`begin; …; commit`), ideally in a single round trip. Optional: when a
   * driver omits it, {@link Database.batch} falls back to {@link transaction}.
   */
  batch?(queries: readonly SqlQuery[]): Promise<OrmQueryResult[]>;

  close?(): Promise<void>;
}

/** Driver transaction facade exposed to transaction callbacks. */
export interface OrmTransaction {
  query<T = unknown>(query: SqlQuery): Promise<OrmQueryResult<T>>;
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
 * The awaitable result of a raw `db.query(...)` call: a normal query-result
 * promise that also exposes `.as(table)`, which decodes the raw driver rows
 * against a table model — physical→JS column naming plus the same opt-in
 * Temporal decoding the query builder applies — yielding typed
 * `InferSelect<table>` rows. Lets a hand-written `sql` query (e.g. a
 * data-modifying CTE) reuse a `defineTable` model instead of a restated row
 * type.
 */
export interface MappableQueryResult<T = unknown>
  extends Promise<OrmQueryResult<T>> {
  as<TTable extends TableDefinition>(
    table: TTable,
  ): Promise<InferSelect<TTable>[]>;
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

  /** Names a common table expression; complete it with `.as(query)`. */
  $with(name: string): CteBuilder;
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

  /**
   * Runs several pre-built statements as one atomic, **non-interactive**
   * transaction — ideal for Deno Deploy / Neon HTTP, where an interactive
   * `transaction()` callback holds a connection open. Each statement is a query
   * builder, a `` sql`...` `` fragment, or rendered SQL; they commit together and
   * roll back on any failure, returning one result per statement. No statement
   * may depend on a previous one's result (that is what `transaction()` and
   * database functions are for).
   */
  batch(statements: readonly BatchStatement[]): Promise<OrmQueryResult[]>;

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
  /** Opt-in Temporal result parsing for ORM-built queries with column metadata. */
  readonly temporal?: TemporalParsingOptions;
}

/** Options for the in-memory ORM driver. */
export interface MemoryOrmDriverOptions {
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
    logger: options.logger,
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
  readonly logger?: Logger;
  readonly schema?: TSchema;
  readonly relations?: TRelations;
  readonly temporal?: TemporalParsingOptions;
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
  readonly #temporal: TemporalParsingOptions;
  readonly #relationRegistry: RelationRegistry;

  constructor(options: SisalDatabaseOptions<TSchema, TRelations>) {
    this.#driver = options.driver;
    this.dialect = options.dialect;
    this.#logger = options.logger;
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

  // Wraps a raw query promise with `.as(table)` so its rows can be decoded
  // against a table model (physical→JS naming + opt-in Temporal parsing).
  #mappableQuery<T>(
    query: SqlInput,
    params?: readonly SqlParameter[],
  ): MappableQueryResult<T> {
    const promise = this.#query<T>(query, params) as MappableQueryResult<T>;
    promise.as = <TTable extends TableDefinition>(table: TTable) => {
      assertTable(table);
      return promise.then((result) =>
        this.#mapRows(result.rows as Record<string, unknown>[], table)
      );
    };
    return promise;
  }

  // Maps raw driver rows onto a table model: renames physical column names to
  // their JS property keys, then applies the same opt-in Temporal decoding the
  // builder uses. Unknown keys pass through untouched.
  #mapRows<TTable extends TableDefinition>(
    rows: readonly Record<string, unknown>[],
    table: TTable,
  ): InferSelect<TTable>[] {
    const rename: Record<string, string> = {};
    const metadata: Record<string, ResultColumnMetadata> = {};
    for (const [property, column] of Object.entries(table.columns)) {
      rename[column.name] = property;
      metadata[property] = column;
    }
    const parse = this.#temporal.parse === true;
    return rows.map((row) => {
      const mapped: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        mapped[rename[key] ?? key] = value;
      }
      return (parse
        ? decodeTemporalRow(mapped, metadata)
        : mapped) as InferSelect<TTable>;
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
          temporal: this.#temporal,
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

    const startedAt = performance.now();
    this.#debug({ statements: queries.length }, "orm batch started");

    try {
      const results = await this.#runBatch(queries);
      this.#debug(
        { statements: queries.length, durationMs: elapsedMs(startedAt) },
        "orm batch completed",
      );
      return results;
    } catch (error) {
      this.#error({ statements: queries.length }, "orm batch failed");
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
    return normalizeSqlInput(input, undefined, this.dialect);
  }

  async #runBatch(queries: SqlQuery[]): Promise<OrmQueryResult[]> {
    // Prefer a driver's native batch (one round trip where supported).
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
    // A minimal driver with no transaction: run sequentially (not atomic).
    const results: OrmQueryResult[] = [];
    for (const query of queries) {
      results.push(await this.#driver.execute(query));
    }
    return results;
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
      return this.#decodeResult(rendered, result);
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

/**
 * Defines an {@link AtomicOperation} from a transaction-scoped body. The body
 * receives a transaction-scoped {@link Database} plus the typed input and may run
 * dependent steps (a read that drives a later write). The same operation runs
 * identically on every adapter, so application code is shaped by the domain, not
 * the engine.
 *
 * Currently every adapter runs the body as an **interactive transaction**. The
 * authored body is forward-compatible with a future single-round-trip path that
 * dispatches Postgres-family adapters to a generated database function (v0.5.0
 * roadmap items 7/12).
 *
 * @example
 * const recordVote = defineAtomicOperation<{ postId: number }, number>(
 *   "record_vote",
 *   async (tx, { postId }) => {
 *     const [post] = await tx.select().from(posts)
 *       .where(eq(posts.columns.id, postId)).execute();
 *     const next = Number(post.votes) + 1;
 *     await tx.update(posts).set({ votes: next })
 *       .where(eq(posts.columns.id, postId)).execute();
 *     return next;
 *   },
 * );
 * const votes = await recordVote.run(db, { postId: 1 });
 */
export function defineAtomicOperation<TInput, TOutput>(
  name: string,
  body: (tx: Database, input: TInput) => Promise<TOutput>,
): AtomicOperation<TInput, TOutput> {
  return Object.freeze({
    name,
    run(db: Database, input: TInput): Promise<TOutput> {
      return db.transaction((tx) => body(tx, input));
    },
  });
}
