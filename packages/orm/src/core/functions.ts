/**
 * Typed database-function descriptors (`defineFunction`) and the `db.call`
 * caller behind them. A descriptor declares positional argument column types
 * and a return shape (a `RETURNS TABLE` row map or a single scalar column);
 * `db.call(fn, args)` renders one `SELECT * FROM fn($1::t1, …)` statement with
 * the casts taken from the argument column types and every value bound.
 *
 * Part of the `@sisal/orm` core; re-exported through `./mod.ts`.
 */

import {
  type ColumnBuilder,
  type ColumnDefinition,
  emptySql,
  identifier,
  joinSql,
  OrmError,
  raw,
  type Sql,
} from "@sisal/core";
import {
  attachResultMetadata,
  isColumnBuilder,
  isRecord,
  paramSql,
  type ResultRowMetadata,
} from "@sisal/core/unstable-internal";
import type { Database } from "./database.ts";

/** Column-builder map describing a function's positional arguments. */
export type FunctionArgsConfig = Record<
  string,
  ColumnBuilder<unknown, boolean, boolean>
>;

/**
 * A function's return shape: a column map (`RETURNS TABLE (...)`, yielding a
 * typed row) or a single column builder (a scalar, yielding a typed value).
 */
export type FunctionReturnsConfig =
  | Record<string, ColumnBuilder<unknown, boolean, boolean>>
  | ColumnBuilder<unknown, boolean, boolean>;

/** Config object accepted by {@link defineFunction}. */
export interface FunctionConfig<
  TArgs extends FunctionArgsConfig,
  TReturns extends FunctionReturnsConfig,
> {
  /** Positional arguments, in declared order, as column builders. */
  readonly args?: TArgs;
  /** The function's return shape (row map or scalar column). */
  readonly returns: TReturns;
}

/** The value type a single column builder reads (mirrors `InferSelect`). */
type ColumnValue<TBuilder> = TBuilder extends
  ColumnBuilder<infer TValue, boolean, boolean> ? TValue : never;

/** The positional-argument input object inferred from a function's `args`. */
export type FunctionArgsInput<TArgs extends FunctionArgsConfig> = {
  readonly [K in keyof TArgs]: ColumnValue<TArgs[K]>;
};

/** The row (table return) or scalar value a function call yields. */
export type FunctionRow<TReturns extends FunctionReturnsConfig> =
  TReturns extends ColumnBuilder<infer TScalar, boolean, boolean> ? TScalar
    : TReturns extends Record<string, ColumnBuilder<unknown, boolean, boolean>>
      ? { readonly [K in keyof TReturns]: ColumnValue<TReturns[K]> }
    : never;

/** Internal: one materialized argument — its name and SQL cast type. */
interface FunctionArgMeta {
  readonly name: string;
  readonly castType: string;
}

/** Internal: a materialized return shape. */
type FunctionReturnMeta =
  | { readonly kind: "scalar"; readonly column: ColumnDefinition<unknown> }
  | {
    readonly kind: "table";
    readonly columns: Readonly<Record<string, ColumnDefinition<unknown>>>;
  };

/**
 * A typed database-function descriptor produced by {@link defineFunction}. Pass
 * it to {@link Database.call} to render and run a single
 * `SELECT * FROM fn(args)` statement. The two type parameters carry the inferred
 * argument-input and row types and are not present at runtime.
 */
export interface FunctionDefinition<
  TArgsInput = Record<string, unknown>,
  TRow = unknown,
> /** Discriminator for this function definition. */ {
  /** Name used by this function definition. */
  readonly kind: "function";
  /** Bound parameters used by this function definition. */
  readonly name: string;
  /** returns for this function definition. */
  readonly args: readonly FunctionArgMeta[];
  /** returns for this function definition. */
  readonly returns: FunctionReturnMeta;
  /** Phantom carrier for the inferred argument-input type (compile-time only). */
  readonly __argsInput?: TArgsInput;
  /** Phantom carrier for the inferred row type (compile-time only). */
  readonly __row?: TRow;
}

/** The result of {@link Database.call}: a renderable, runnable function call. */
export interface FunctionCall<TRow> {
  /** Renders the call to a SQL fragment. */
  toSql(): Sql;
  /** Runs the call and returns all result rows (or scalar values). */
  execute(): Promise<TRow[]>;
  /** Runs the call and asserts exactly one row, returning it. */
  one(): Promise<TRow>;
}

// Output-column alias for scalar calls, so the single value reads back by key.
const SCALAR_ALIAS = "result";

/**
 * Declares a typed database function: its positional argument column types and
 * its return shape (a `RETURNS TABLE (...)` row map or a single scalar column).
 *
 * ```ts
 * const votePost = defineFunction("app.vote_post", {
 *   args: { postId: columns.uuid(), value: columns.smallint() },
 *   returns: { id: columns.uuid(), hot_score: columns.doublePrecision() },
 * });
 * const [row] = await db.call(votePost, { postId, value: -1 }).execute();
 * ```
 *
 * `name` may be schema-qualified (e.g. `"app.vote_post"`); it renders as a
 * quoted identifier path. Arguments are positional by declared order and cast
 * from their column types; result rows are typed from `returns`.
 */
export function defineFunction<
  TReturns extends FunctionReturnsConfig,
  TArgs extends FunctionArgsConfig = Record<never, never>,
>(
  name: string,
  config: FunctionConfig<TArgs, TReturns>,
): FunctionDefinition<FunctionArgsInput<TArgs>, FunctionRow<TReturns>> {
  // Validate the (possibly schema-qualified) name up front.
  identifier(name);
  if (!isRecord(config) || config.returns === undefined) {
    throw new OrmError("defineFunction requires a returns shape", {
      code: "ORM_INVALID_QUERY",
      details: { function: name },
    });
  }

  return Object.freeze({
    kind: "function",
    name,
    args: buildArgs(name, config.args),
    returns: buildReturns(name, config.returns),
  }) as FunctionDefinition<FunctionArgsInput<TArgs>, FunctionRow<TReturns>>;
}

/** Builds a {@link FunctionCall} from a definition and an argument object. */
export function createFunctionCall<TRow>(
  database: Database,
  definition: FunctionDefinition<unknown, TRow>,
  args: unknown,
): FunctionCall<TRow> {
  assertFunctionDefinition(definition);
  return new SisalFunctionCall<TRow>(
    database,
    definition,
    bindArgs(definition, args),
  );
}

class SisalFunctionCall<TRow> implements FunctionCall<TRow> {
  readonly #database: Database;
  readonly #definition: FunctionDefinition;
  readonly #args: Record<string, unknown>;

  constructor(
    database: Database,
    definition: FunctionDefinition,
    args: Record<string, unknown>,
  ) {
    this.#database = database;
    this.#definition = definition;
    this.#args = args;
  }

  toSql(): Sql {
    return functionCallSql(this.#definition, this.#args);
  }

  async execute(): Promise<TRow[]> {
    const result = await this.#database.query<Record<string, unknown>>(
      this.toSql(),
    );
    if (this.#definition.returns.kind === "scalar") {
      return result.rows.map((row) => row[SCALAR_ALIAS] as TRow);
    }
    return result.rows as TRow[];
  }

  async one(): Promise<TRow> {
    const rows = await this.execute();
    if (rows.length !== 1) {
      throw new OrmError("Expected exactly one row from function call", {
        code: "ORM_INVALID_QUERY",
        details: { function: this.#definition.name, rowCount: rows.length },
      });
    }
    return rows[0];
  }
}

function functionCallSql(
  definition: FunctionDefinition,
  args: Record<string, unknown>,
): Sql {
  const argParts = definition.args.map((arg) =>
    joinSql(
      [paramSql(args[arg.name]), raw("::"), raw(arg.castType)],
      emptySql(),
    )
  );
  const callExpr = joinSql([
    identifier(definition.name),
    raw("("),
    joinSql(argParts, raw(", ")),
    raw(")"),
  ], emptySql());

  if (definition.returns.kind === "scalar") {
    return attachResultMetadata(
      joinSql(
        [raw("select "), callExpr, raw(" as "), identifier(SCALAR_ALIAS)],
        emptySql(),
      ),
      { [SCALAR_ALIAS]: definition.returns.column },
    );
  }
  return attachResultMetadata(
    joinSql([raw("select * from "), callExpr], emptySql()),
    tableFunctionResultMetadata(definition.returns.columns),
  );
}

function tableFunctionResultMetadata(
  columns: Readonly<Record<string, ColumnDefinition<unknown>>>,
): ResultRowMetadata {
  return columns;
}

function buildArgs(
  fnName: string,
  argsConfig: FunctionArgsConfig | undefined,
): FunctionArgMeta[] {
  if (argsConfig === undefined) {
    return [];
  }
  if (!isRecord(argsConfig)) {
    throw new OrmError("Function args must be a column map", {
      code: "ORM_INVALID_QUERY",
      details: { function: fnName },
    });
  }

  return Object.entries(argsConfig).map(([name, builder]) => {
    if (!isColumnBuilder(builder)) {
      throw new OrmError("Function argument must be a ColumnBuilder", {
        code: "ORM_INVALID_COLUMN",
        details: { function: fnName, argument: name },
      });
    }
    return { name, castType: castTypeFor(builder.definition) };
  });
}

function buildReturns(
  fnName: string,
  returnsConfig: FunctionReturnsConfig,
): FunctionReturnMeta {
  if (isColumnBuilder(returnsConfig)) {
    return { kind: "scalar", column: returnsConfig.definition };
  }
  if (isRecord(returnsConfig)) {
    const entries = Object.entries(returnsConfig);
    if (entries.length === 0) {
      throw new OrmError("Function returns requires at least one column", {
        code: "ORM_INVALID_QUERY",
        details: { function: fnName },
      });
    }
    for (const [name, builder] of entries) {
      if (!isColumnBuilder(builder)) {
        throw new OrmError("Function return column must be a ColumnBuilder", {
          code: "ORM_INVALID_COLUMN",
          details: { function: fnName, column: name },
        });
      }
    }
    const columns: Record<string, ColumnDefinition<unknown>> = {};
    for (const [name, builder] of entries) {
      columns[name] = builder.definition;
    }
    return { kind: "table", columns };
  }
  throw new OrmError("Function returns must be a column or a column map", {
    code: "ORM_INVALID_QUERY",
    details: { function: fnName },
  });
}

// Derives the SQL cast type emitted for an argument from its column metadata.
function castTypeFor(definition: ColumnDefinition<unknown>): string {
  const base = baseCastType(definition);
  const castType = definition.array === true ? `${base}[]` : base;
  assertSafeCastType(castType);
  return castType;
}

function baseCastType(definition: ColumnDefinition<unknown>): string {
  if (definition.dialectType !== undefined) {
    return definition.dialectType;
  }
  switch (definition.dataType) {
    case "double":
    case "number":
      return "double precision";
    case "varchar":
      return definition.length === undefined
        ? "varchar"
        : `varchar(${definition.length})`;
    case "char":
      return definition.length === undefined
        ? "char"
        : `char(${definition.length})`;
    case "numeric":
    case "decimal":
      if (definition.precision === undefined) {
        return "numeric";
      }
      return definition.scale === undefined
        ? `numeric(${definition.precision})`
        : `numeric(${definition.precision}, ${definition.scale})`;
    default:
      // The remaining built-in dataTypes (text/integer/uuid/timestamptz/…) are
      // already valid SQL cast types; custom kinds pass through verbatim.
      return definition.dataType;
  }
}

// The cast type is interpolated into SQL text, so guard it the way DDL guards
// the (trusted) customType dialectType: allow only type-name characters.
function assertSafeCastType(castType: string): void {
  if (!/^[A-Za-z0-9_ ,()[\]]+$/.test(castType)) {
    throw new OrmError("Unsafe function argument cast type", {
      code: "ORM_INVALID_COLUMN",
      details: { castType },
    });
  }
}

function bindArgs(
  definition: FunctionDefinition,
  args: unknown,
): Record<string, unknown> {
  const bound: Record<string, unknown> = {};
  for (const arg of definition.args) {
    if (!isRecord(args) || !Object.hasOwn(args, arg.name)) {
      throw new OrmError("Missing function argument", {
        code: "ORM_INVALID_QUERY",
        details: { function: definition.name, argument: arg.name },
      });
    }
    bound[arg.name] = (args as Record<string, unknown>)[arg.name];
  }
  return bound;
}

function assertFunctionDefinition(
  value: unknown,
): asserts value is FunctionDefinition {
  if (
    !isRecord(value) || value.kind !== "function" ||
    typeof value.name !== "string" || !Array.isArray(value.args) ||
    !isRecord(value.returns)
  ) {
    throw new OrmError("Expected a function definition", {
      code: "ORM_INVALID_QUERY",
    });
  }
}
