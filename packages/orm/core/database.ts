/**
 * The `Database` facade, the `OrmDriver` contract, and the built-in drivers.
 *
 * Part of the `@sisal/orm` core; re-exported through `./mod.ts`.
 */

import type { Logger } from "../logger.ts";
import {
  type Cte,
  CTE_DEFINITIONS,
  type CteBuilder,
  cteColumnKeys,
  type DeleteBuilder,
  type InsertBuilder,
  type SelectBuilder,
  type SetOperand,
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
  type SqlDialect,
  type SqlInput,
  type SqlParameter,
  type SqlQuery,
} from "./sql.ts";
import {
  type AnyTableDefinition,
  assertTable,
  type TableDefinition,
} from "./table.ts";
import { decodeTemporalRow, type TemporalParsingOptions } from "./temporal.ts";

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

  $with(name: string): CteBuilder {
    return {
      as: <TResult>(
        query: SetOperand<TResult>,
      ): Cte<{ readonly [K in keyof TResult]-?: SelectColumnRef }> => {
        const columns: Record<string, SelectColumnRef> = {};
        for (const key of cteColumnKeys(query)) {
          columns[key] = {
            name: key,
            tableName: name,
            dataType: "unknown",
          } as unknown as SelectColumnRef;
        }
        CTE_DEFINITIONS.set(columns, { name, query: query.toSql() });
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
