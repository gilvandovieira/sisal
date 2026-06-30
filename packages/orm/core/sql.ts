/**
 * Typed SQL fragments: the `sql` tag, identifier/parameter rendering, the
 * dialect-aware renderer, prepared-statement plans, and condition wrappers.
 *
 * Part of the `@sisal/orm` core; re-exported through `./mod.ts`.
 */

import type { ColumnDefinition } from "./columns.ts";
import { OrmError, type OrmErrorCode } from "./errors.ts";
import {
  isTemporalSqlValue,
  normalizeTemporalSqlValue,
  type ResultRowMetadata,
  serializeTemporalValue,
  type TemporalSqlValue,
} from "./temporal.ts";

/** Normalized table name, optionally including a validated schema path. */
export type TableName = string;

/** Normalized simple column name. */
export type ColumnName = string;

/** SQL dialect names supported by SQL rendering helpers. */
export type SqlDialect = "postgres" | "sqlite" | "mysql" | "generic";

/** Parameter value shape accepted by rendered SQL queries. */
export type SqlParameter =
  | string
  | number
  | boolean
  | null
  | Date
  | TemporalSqlValue
  | Uint8Array
  | Record<string, unknown>
  | unknown[];

/** Driver-ready SQL text and parameter array. */
export interface SqlQuery {
  readonly text: string;
  readonly params: readonly SqlParameter[];
}

const RESULT_METADATA = new WeakMap<object, ResultRowMetadata>();

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
  | { readonly kind: "placeholder"; readonly name: string }
  | { readonly kind: "raw"; readonly value: string }
  | { readonly kind: "identifier"; readonly value: string }
  | { readonly kind: "operator"; readonly value: string }
  | {
    readonly kind: "guard";
    readonly construct: string;
    readonly unsupported: readonly SqlDialect[];
  }
  | {
    readonly kind: "dialect";
    readonly construct: string;
    readonly variants: { readonly [D in SqlDialect]?: Sql };
    readonly fallback?: Sql;
  }
  | { readonly kind: "sql"; readonly value: Sql };

/** Boolean SQL condition wrapper used by query builders. */
export interface Condition {
  readonly kind: "condition";
  readonly sql: Sql;
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

/**
 * An `ORDER BY` term produced by `asc()`/`desc()`. It is a SQL fragment
 * (`"t"."col" asc`) that also carries the underlying column and its direction,
 * so keyset pagination can build the matching comparison predicate and derive a
 * cursor. `TKey` is the column's JS property name, used to infer the cursor
 * shape; it is a phantom type with no runtime presence.
 */
export interface OrderTerm<TKey extends string = string> extends Sql {
  /** The column reference (or raw operand) this term orders by. */
  readonly column: unknown;
  /** The sort direction. */
  readonly direction: "asc" | "desc";
  /** Phantom carrier for the ordered column's property key (compile-time only). */
  readonly __orderKey?: TKey;
}

/** Returns true when a value is an `asc()`/`desc()` {@link OrderTerm}. */
export function isOrderTerm(value: unknown): value is OrderTerm {
  return isSql(value) &&
    (value as { direction?: unknown }).direction !== undefined &&
    "column" in (value as object);
}

/**
 * A value usable in a select projection: a column reference, a SQL expression,
 * or a select/compound builder embedded as a scalar subquery.
 */
export type SelectProjectionValue = SelectColumnRef | Sql | SubquerySource;

/** Map of result key to selected column or expression, for `db.select({ ... })`. */
export type SelectProjection = Record<string, SelectProjectionValue>;

/** Resolves the value a projection entry (column or expression) yields in a result row. */
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

/** Placeholder name → bound value map supplied when running a prepared query. */
export type PlaceholderValues = Record<string, SqlParameter>;

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
      } else if (isQueryBuilder(value)) {
        // A select/compound builder embeds as a parenthesized scalar subquery.
        chunks.push({ kind: "sql", value: subquerySql(value) });
      } else if (isColumn(value)) {
        // A column reference renders as a validated, quoted identifier (e.g. in
        // a `check()` expression), not a bound parameter.
        chunks.push({ kind: "sql", value: columnToSql(value) });
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

/**
 * Creates a named placeholder fragment for a prepared statement.
 *
 * A placeholder renders as a parameter slot whose value is supplied later, when
 * the query is run via {@link SelectBuilder.prepare} (and the other builders'
 * `prepare`) and executed with a `{ name: value }` map. Use it anywhere a bound
 * value is accepted — inside the `` sql`...` `` tag or as the right side of an
 * operator, e.g. `eq(users.columns.id, placeholder("id"))`.
 *
 * Mirrors Drizzle's `sql.placeholder(name)`.
 */
export function placeholder(name: string): Sql {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new OrmError("Placeholder name must be a non-empty string", {
      code: "ORM_INVALID_SQL",
      details: { name },
    });
  }
  return makeSql([{ kind: "placeholder", name }]);
}

/** Renders a SQL fragment into driver text and parameter array. */
export function renderSql(
  query: Sql,
  options: {
    readonly dialect?: SqlDialect;
  } = {},
): SqlQuery {
  const plan = renderToPlan(query, options.dialect ?? "generic");
  const params = plan.params.map((param) => {
    if (param.kind === "placeholder") {
      throw new OrmError(
        `Cannot render SQL with an unbound placeholder "${param.name}"; ` +
          "use a prepared statement (.prepare().execute(values))",
        { code: "ORM_INVALID_SQL", details: { placeholder: param.name } },
      );
    }
    return param.value;
  });

  const rendered = { text: plan.text, params };
  copyResultMetadata(query, rendered);
  return rendered;
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
      params: params === undefined ? [] : params.map(serializeSqlValue),
    };
  }

  if (isSqlQuery(query)) {
    if (params !== undefined && params.length > 0) {
      throw new OrmError("SqlQuery cannot receive external params", {
        code: "ORM_INVALID_SQL",
      });
    }

    const normalized = {
      text: query.text,
      params: query.params.map(serializeSqlValue),
    };
    copyResultMetadata(query, normalized);
    return normalized;
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

  if (isTemporalSqlValue(value)) {
    return serializeTemporalValue(value);
  }

  const normalized = normalizeTemporalSqlValue(value);
  if (normalized !== value) {
    return serializeSqlValue(normalized);
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
    return value.map(serializeSqlValue);
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

function makeSql(chunks: SqlChunk[]): Sql {
  return Object.freeze({
    kind: "sql",
    chunks: Object.freeze([...chunks]),
  });
}

export function paramSql(value: unknown): Sql {
  return makeSql([{ kind: "param", value: serializeSqlValue(value) }]);
}

/** Attaches ORM result-column metadata to a SQL fragment or rendered query. */
export function attachResultMetadata<T extends object>(
  value: T,
  metadata: ResultRowMetadata | undefined,
): T {
  if (metadata !== undefined && Object.keys(metadata).length > 0) {
    RESULT_METADATA.set(value, metadata);
  }
  return value;
}

/** Returns ORM result-column metadata attached to a SQL fragment/query. */
export function getResultMetadata(
  value: object,
): ResultRowMetadata | undefined {
  return RESULT_METADATA.get(value);
}

/** Copies result-column metadata between SQL fragments/rendered queries. */
export function copyResultMetadata(from: object, to: object): void {
  attachResultMetadata(to, RESULT_METADATA.get(from));
}

/**
 * One rendered parameter slot: either a literal value, or a {@link placeholder}
 * whose value is bound when a prepared statement is executed.
 */
type PreparedParam =
  | { readonly kind: "value"; readonly value: SqlParameter }
  | { readonly kind: "placeholder"; readonly name: string };

/** A query rendered to driver text plus its ordered parameter slots. */
export interface PreparedPlan {
  readonly text: string;
  readonly params: readonly PreparedParam[];
}

interface RenderState {
  text: string;
  params: PreparedParam[];
  dialect: SqlDialect;
}

/** Renders a SQL fragment to a plan whose param slots may include placeholders. */
export function renderToPlan(query: Sql, dialect: SqlDialect): PreparedPlan {
  if (!isSql(query)) {
    throw new OrmError("Expected a SQL fragment", {
      code: "ORM_INVALID_SQL",
    });
  }

  const state: RenderState = { text: "", params: [], dialect };
  renderSqlInto(query, state);

  return { text: state.text, params: state.params };
}

/** Resolves a prepared plan against placeholder values into a driver query. */
export function fillPreparedPlan(
  plan: PreparedPlan,
  values: PlaceholderValues,
): SqlQuery {
  const params = plan.params.map((param) => {
    if (param.kind === "value") {
      return param.value;
    }
    if (!isRecord(values) || !Object.hasOwn(values, param.name)) {
      throw new OrmError(`Missing value for placeholder "${param.name}"`, {
        code: "ORM_INVALID_QUERY",
        details: { placeholder: param.name },
      });
    }
    return serializeSqlValue(values[param.name]);
  });

  return { text: plan.text, params };
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
      state.params.push({ kind: "value", value: chunk.value });
      state.text += positionalMarker(state);
      continue;
    }

    if (chunk.kind === "placeholder") {
      state.params.push({ kind: "placeholder", name: chunk.name });
      state.text += positionalMarker(state);
      continue;
    }

    if (chunk.kind === "operator") {
      state.text += renderOperator(chunk.value, state.dialect);
      continue;
    }

    if (chunk.kind === "guard") {
      if (chunk.unsupported.includes(state.dialect)) {
        throw new OrmError(
          `${chunk.construct} is not supported by the "${state.dialect}" ` +
            `dialect; it is PostgreSQL-only`,
          {
            code: "ORM_DIALECT_UNSUPPORTED",
            details: { construct: chunk.construct, dialect: state.dialect },
          },
        );
      }
      continue;
    }

    if (chunk.kind === "dialect") {
      const variant = chunk.variants[state.dialect] ?? chunk.fallback;
      if (variant === undefined) {
        throw new OrmError(
          `${chunk.construct} is not supported by the "${state.dialect}" ` +
            "dialect",
          {
            code: "ORM_DIALECT_UNSUPPORTED",
            details: { construct: chunk.construct, dialect: state.dialect },
          },
        );
      }
      renderSqlInto(variant, state);
      continue;
    }

    renderSqlInto(chunk.value, state);
  }
}

// Postgres uses ordinal `$N` markers; every other dialect uses `?`.
function positionalMarker(state: RenderState): string {
  return state.dialect === "postgres" ? `$${state.params.length}` : "?";
}

// Maps an operator name to dialect-specific SQL. Only Postgres has `ILIKE`;
// SQLite/libSQL/MySQL `LIKE` is already case-insensitive for ASCII, so `ilike`
// degrades to `like` there instead of producing invalid SQL.
function renderOperator(operator: string, dialect: SqlDialect): string {
  if (dialect === "postgres") {
    return operator;
  }
  if (operator === "ilike") {
    return "like";
  }
  if (operator === "not ilike") {
    return "not like";
  }
  return operator;
}

export function operatorSql(name: string): Sql {
  return makeSql([{ kind: "operator", value: name }]);
}

/**
 * A zero-width SQL marker that makes rendering throw an `OrmError` when the
 * query is rendered for any dialect in `unsupported`. Used to fail fast on
 * PostgreSQL-only constructs (`distinctOn`, row locking, array operators) with a
 * clear, typed error before they reach a SQLite-family engine as invalid SQL.
 */
export function dialectGuard(
  construct: string,
  unsupported: readonly SqlDialect[],
): Sql {
  return makeSql([{ kind: "guard", construct, unsupported }]);
}

/**
 * A SQL fragment that renders differently per dialect: at render time the
 * `variants` entry for the active dialect is emitted, falling back to
 * `fallback` when the dialect has no entry. If neither matches, rendering throws
 * a typed `OrmError` (`code: "ORM_DIALECT_UNSUPPORTED"`) naming `construct`.
 * This is the portable-construct primitive behind helpers like `dateTrunc`,
 * whose SQL diverges between PostgreSQL and the SQLite family.
 */
export function dialectSql(
  construct: string,
  variants: { readonly [D in SqlDialect]?: Sql },
  fallback?: Sql,
): Sql {
  return makeSql([{
    kind: "dialect",
    construct,
    variants,
    ...(fallback === undefined ? {} : { fallback }),
  }]);
}

export function createCondition(conditionSql: Sql): Condition {
  return Object.freeze({
    kind: "condition",
    sql: conditionSql,
  });
}

export function assertCondition(value: Condition): void {
  if (!isCondition(value)) {
    throw new OrmError("Expected a condition", {
      code: "ORM_INVALID_QUERY",
    });
  }
}

function isCondition(value: unknown): value is Condition {
  return isRecord(value) && value.kind === "condition" && isSql(value.sql);
}

export function columnToSql(column: unknown): Sql {
  if (isSql(column)) {
    return column;
  }

  if (isQueryBuilder(column)) {
    return subquerySql(column);
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

/**
 * Brand stamped on Sisal's query builders so {@link isQueryBuilder} can detect
 * a subquery source without importing the builder classes (which would couple
 * this module to `./builders.ts`). The builders set this property to `true`.
 */
export const QUERY_BUILDER_BRAND: unique symbol = Symbol("sisal.queryBuilder");

/** A select/compound builder usable as a subquery (derived table or scalar). */
export interface SubquerySource {
  /** Renders the builder to a SQL fragment. */
  toSql(): Sql;
}

/** True for Sisal's select and compound-select builders. */
export function isQueryBuilder(value: unknown): value is SubquerySource {
  return isRecord(value) &&
    (value as Record<PropertyKey, unknown>)[QUERY_BUILDER_BRAND] === true;
}

/** Wraps a builder's SQL in parentheses for use as a subquery. */
export function subquerySql(source: SubquerySource): Sql {
  return joinSql([raw("("), source.toSql(), raw(")")], emptySql());
}

export function assertSubquery(
  value: unknown,
): asserts value is SubquerySource {
  if (!isQueryBuilder(value)) {
    throw new OrmError("exists/notExists require a select subquery", {
      code: "ORM_INVALID_QUERY",
    });
  }
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function cloneSqlQuery(query: SqlQuery): SqlQuery {
  const cloned = {
    text: query.text,
    params: [...query.params],
  };
  copyResultMetadata(query, cloned);
  return cloned;
}
