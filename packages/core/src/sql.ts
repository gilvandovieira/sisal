/**
 * Typed SQL fragments: the `sql` tag, identifier/parameter rendering, the
 * dialect-aware renderer, prepared-statement plans, and condition wrappers.
 *
 * Part of `@sisal/core`; re-exported through `./mod.ts`.
 */

import type { ColumnDefinition } from "./columns.ts";
import { OrmError, type OrmErrorCode } from "./errors.ts";
import {
  isTemporalInstantValue,
  isTemporalSqlValue,
  normalizeTemporalSqlValue,
  type ResultRowMetadata,
  serializeTemporalValue,
  type TemporalSqlValue,
} from "./temporal.ts";

/**
 * Version of the public SQL fragment IR contract — the `Sql`/`SqlChunk`
 * shapes, their render semantics, and the guard/dialect chunk data formats
 * (see `docs/core-ir.md` for the full contract and compatibility policy).
 * Additive changes (new chunk kinds, new optional fields, `meta`
 * annotations) do not bump this; only a change that makes existing serialized
 * chunks render differently would — and the golden per-dialect SQL suites
 * exist to keep that from happening unnoticed.
 */
export const SQL_IR_VERSION = 1 as const;

/** Normalized table name, optionally including a validated schema path. */
export type TableName = string;

/** Normalized simple column name. */
export type ColumnName = string;

/** SQL dialect names supported by SQL rendering helpers. */
export type SqlDialect = "postgres" | "sqlite" | "mysql" | "generic";

/**
 * Runtime companion of {@link SqlDialect}: the render dialects a
 * {@link DialectIdentity}'s `dialect` key collapses to (the 6 capability
 * targets project onto these 4). `satisfies` keeps every entry a valid
 * `SqlDialect`; the reconciliation test additionally asserts the list is
 * exhaustive against the union and matches the snapshot's `SisalDialectName`,
 * so the render/snapshot/capability key spaces cannot drift apart.
 */
export const SQL_DIALECTS = [
  "postgres",
  "sqlite",
  "mysql",
  "generic",
] as const satisfies readonly SqlDialect[];

/**
 * Version-aware dialect identity — the `(engine, variant, version)` key the
 * v0.6 readiness investigation decided on (see `docs/mysql-readiness.md`,
 * decision 2). `dialect` remains the render key; `variant` names a
 * protocol-compatible sibling engine (`"mariadb"` for the `mysql` dialect;
 * `"neon"`/`"libsql"` are reserved for the pg/sqlite families), and `version`
 * is the server version string as reported by the engine (a leading dotted
 * numeric prefix is compared; suffixes like `"-MariaDB-ubu2404"` are
 * ignored). Everywhere a bare {@link SqlDialect} is accepted, the identity is
 * too — a bare dialect means "base engine, version unknown".
 */
export interface DialectIdentity {
  /** SQL dialect family for the connected engine. */
  readonly dialect: SqlDialect;
  /** Optional engine variant, such as `mariadb`. */
  readonly variant?: string;
  /** Optional server version used for capability checks. */
  readonly version?: string;
}

/**
 * One dialect a guarded construct is unsupported on. A bare {@link SqlDialect}
 * matches any variant/version of that dialect; the object form narrows to one
 * `variant` (an identity with **no** variant is the base engine and does not
 * match a variant-narrowed target).
 */
export type DialectGuardTarget = SqlDialect | {
  readonly dialect: SqlDialect;
  readonly variant?: string;
};

/**
 * A refinement that lifts a {@link dialectGuard} for identities it matches:
 * the identity's `dialect` must equal `dialect` (when set — scopes the
 * exception to one of the guard's engines when a guard targets several), its
 * `variant` must equal `variant` (when set), and its `version` must be
 * **known** and at least `minVersion` (when set) — an unknown version never
 * lifts a guard (fail closed), so capabilities only light up when the adapter
 * has really identified the server.
 *
 * `baseEngine: true` narrows the lift to the **base engine only** — an identity
 * with no `variant`. It expresses a version gate that excludes a
 * protocol-compatible variant, e.g. "functional indexes on base MySQL ≥ 8.0.13
 * but never MariaDB": `unless: [{ baseEngine: true, minVersion: "8.0.13" }]`.
 * Without it a variant-less exception lifts every variant, and MariaDB 11.x is
 * numerically ≥ 8.0.13 so it would wrongly clear the floor.
 */
export interface DialectGuardException {
  /** Dialect family the exception can lift. */
  readonly dialect?: SqlDialect;
  /** Optional variant the exception is scoped to. */
  readonly variant?: string;
  /** Minimum known server version required to lift the guard. */
  readonly minVersion?: string;
  /** Lift only for the base engine (no `variant`) — excludes variants like MariaDB. */
  readonly baseEngine?: boolean;
}

/**
 * Compares two server version strings by their leading dotted numeric
 * prefixes (`"11.8.8-MariaDB-ubu2404"` → `11.8.8`; missing segments are `0`).
 * Returns a negative number, zero, or a positive number as `a` is lower than,
 * equal to, or higher than `b`. Non-numeric versions compare as `0.0.0`.
 */
export function compareServerVersions(a: string, b: string): number {
  const parse = (value: string): number[] =>
    (value.match(/^\d+(?:\.\d+)*/)?.[0] ?? "0")
      .split(".")
      .map((part) => Number(part));
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** Normalizes a bare dialect or identity into a {@link DialectIdentity}. */
function toDialectIdentity(
  dialect: SqlDialect | DialectIdentity,
): DialectIdentity {
  return typeof dialect === "string" ? { dialect } : dialect;
}

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
  /** Dialect-rendered SQL text with placeholders. */
  readonly text: string;
  /** Bound parameters matched to placeholders in {@link text}. */
  readonly params: readonly SqlParameter[];
}

const RESULT_METADATA = new WeakMap<object, ResultRowMetadata>();

/** Any SQL input accepted by database execution methods. */
export type SqlInput = Sql | SqlQuery | string;

/** SQL fragment made from safe chunks and separate parameters. */
export interface Sql {
  /** Discriminator for Sisal SQL fragments. */
  readonly kind: "sql";
  /** Ordered SQL chunks that render into text and parameters. */
  readonly chunks: readonly SqlChunk[];
}

/**
 * Opaque per-chunk annotations — the additive extension seam reserved by the
 * v0.8 transformable-AST decision. The renderer never reads it; composition
 * (the `sql` tag, `joinSql`, builder assembly) carries annotated chunks by
 * reference, so an origin/AST capture attached here survives into the
 * composed statement. A future introspectable AST can populate this slot as
 * a minor, non-breaking version bump instead of reshaping `SqlChunk`.
 */
export type SqlChunkMeta = Readonly<Record<string, unknown>>;

/** Internal chunk representation used by parameterized SQL fragments. */
export type SqlChunk = SqlChunkVariant & { readonly meta?: SqlChunkMeta };

type SqlChunkVariant =
  | { readonly kind: "text"; readonly value: string }
  | {
    readonly kind: "param";
    readonly value: SqlParameter;
    /**
     * Set when the param's source was an instant (`Temporal.Instant` /
     * `Temporal.ZonedDateTime`), whose ISO serialization carries a `Z`
     * suffix. MySQL rejects zone designators in datetime literals, so the
     * renderer rewrites tagged values to naive UTC under the `mysql`
     * dialect; other dialects render them unchanged.
     */
    readonly temporal?: "instant";
  }
  | { readonly kind: "placeholder"; readonly name: string }
  | { readonly kind: "raw"; readonly value: string }
  | { readonly kind: "identifier"; readonly value: string }
  | { readonly kind: "operator"; readonly value: string }
  | {
    readonly kind: "guard";
    readonly construct: string;
    readonly unsupported: readonly DialectGuardTarget[];
    readonly unless?: readonly DialectGuardException[];
  }
  | {
    readonly kind: "dialect";
    readonly construct: string;
    readonly variants: { readonly [D in SqlDialect]?: Sql };
    readonly fallback?: Sql;
  }
  | { readonly kind: "sql"; readonly value: Sql };

/**
 * Returns a fragment whose chunks carry `meta` (merged over any existing
 * annotations). Rendering is unaffected; the annotations ride along through
 * composition — see {@link SqlChunkMeta}.
 */
export function withSqlChunkMeta(fragment: Sql, meta: SqlChunkMeta): Sql {
  return makeSql(fragment.chunks.map((chunk) => ({
    ...chunk,
    meta: chunk.meta === undefined ? meta : { ...chunk.meta, ...meta },
  })));
}

/** Reads a chunk's opaque annotations — see {@link SqlChunkMeta}. */
export function sqlChunkMeta(chunk: SqlChunk): SqlChunkMeta | undefined {
  return chunk.meta;
}

/**
 * Types a fragment as a {@link SqlExpression} of `T` — the name-once handle
 * for computed/metric expressions (v0.8 item 7). Assign it once and reuse it
 * across a projection, `groupBy`, `having`, `orderBy`, and other expressions;
 * every use re-renders the full expression, which is the portable reuse form
 * (SQL alias references are not portable outside `ORDER BY`). Replaces the
 * `as SqlExpression<T>` casts examples previously needed:
 *
 * ```ts
 * const risingScore = expr<number>(
 *   sql`${avg(votes)} * 2.0 + ${sum(comments)} * 0.5`,
 * );
 * db.select({ id, risingScore }).from(t).orderBy(desc(risingScore));
 * ```
 */
export function expr<T>(fragment: Sql): SqlExpression<T> {
  return fragment as SqlExpression<T>;
}

/** Boolean SQL condition wrapper used by query builders. */
export interface Condition {
  /** Discriminator for condition wrappers. */
  readonly kind: "condition";
  /** Predicate SQL fragment represented by this condition. */
  readonly sql: Sql;
}

/**
 * A typed SQL expression (e.g. an aggregate like {@link count}) usable as a
 * value in a select projection. The phantom type parameter drives the inferred
 * result type for that projected key.
 */
export interface SqlExpression<T = unknown> extends Sql {
  /** Phantom marker preserving the expression result type. */
  readonly __exprType?: T;
}

/** A column reference usable in a select projection. */
export interface SelectColumnRef {
  /** Column name on the source table. */
  readonly name: ColumnName;
  /** Source table name for the column. */
  readonly tableName: string;
  /** Optional default value metadata carried with the column. */
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
        chunks.push({
          kind: "param",
          value: serializeSqlValue(value),
          ...(isTemporalInstantValue(value)
            ? { temporal: "instant" as const }
            : {}),
        });
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
    /** Variant of the dialect's engine (e.g. `"mariadb"`); see {@link DialectIdentity}. */
    readonly variant?: string;
    /** Server version string; see {@link DialectIdentity}. */
    readonly version?: string;
  } = {},
): SqlQuery {
  const plan = renderToPlan(query, {
    dialect: options.dialect ?? "generic",
    ...(options.variant === undefined ? {} : { variant: options.variant }),
    ...(options.version === undefined ? {} : { version: options.version }),
  });
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
  dialect: SqlDialect | DialectIdentity = "generic",
): SqlQuery {
  if (isSql(query)) {
    if (params !== undefined && params.length > 0) {
      throw new OrmError("SQL fragments cannot receive external params", {
        code: "ORM_INVALID_SQL",
      });
    }

    return renderSql(query, toDialectIdentity(dialect));
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

/** Wraps a runtime value as a bound SQL parameter fragment. */
export function paramSql(value: unknown): Sql {
  return makeSql([{
    kind: "param",
    value: serializeSqlValue(value),
    ...(isTemporalInstantValue(value) ? { temporal: "instant" as const } : {}),
  }]);
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
  /** Bound parameters used by this prepared plan. */
  readonly text: string;
  /** Bound parameters used by this prepared plan. */
  readonly params: readonly PreparedParam[];
}

interface RenderState {
  text: string;
  params: PreparedParam[];
  dialect: SqlDialect;
  variant?: string;
  version?: string;
}

/** Renders a SQL fragment to a plan whose param slots may include placeholders. */
export function renderToPlan(
  query: Sql,
  dialect: SqlDialect | DialectIdentity,
): PreparedPlan {
  if (!isSql(query)) {
    throw new OrmError("Expected a SQL fragment", {
      code: "ORM_INVALID_SQL",
    });
  }

  const identity = toDialectIdentity(dialect);
  const state: RenderState = {
    text: "",
    params: [],
    dialect: identity.dialect,
    ...(identity.variant === undefined ? {} : { variant: identity.variant }),
    ...(identity.version === undefined ? {} : { version: identity.version }),
  };
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

// MySQL rejects zone designators in datetime literals, so an instant param
// (tagged at serialization time) is re-rendered as its naive UTC text —
// the mysql-family "executor UTC convention".
function mysqlInstantLiteral(value: SqlParameter): SqlParameter {
  if (typeof value !== "string") {
    return value;
  }
  return value.replace(/[zZ]$/u, "").replace("T", " ");
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
      state.params.push({
        kind: "value",
        value: chunk.temporal === "instant" && state.dialect === "mysql"
          ? mysqlInstantLiteral(chunk.value)
          : chunk.value,
      });
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
      if (guardApplies(chunk, state)) {
        throw new OrmError(
          `${chunk.construct} is not supported by the "${state.dialect}" ` +
            `dialect` +
            (state.variant === undefined
              ? ""
              : ` (variant ${state.variant}${
                state.version === undefined ? "" : ` ${state.version}`
              })`),
          {
            code: "ORM_DIALECT_UNSUPPORTED",
            details: {
              construct: chunk.construct,
              dialect: state.dialect,
              ...(state.variant === undefined
                ? {}
                : { variant: state.variant }),
              ...(state.version === undefined
                ? {}
                : { version: state.version }),
            },
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

// Whether a guard chunk applies to the rendering identity: some `unsupported`
// target must match (bare dialect = any variant; a variant-narrowed target
// requires that exact variant), and no `unless` refinement may lift it. An
// unknown variant is the base engine; an unknown version never satisfies a
// `minVersion` refinement (fail closed — capabilities light up only when the
// adapter has identified the server).
function guardApplies(
  chunk: {
    readonly unsupported: readonly DialectGuardTarget[];
    readonly unless?: readonly DialectGuardException[];
  },
  state: RenderState,
): boolean {
  return dialectGuardApplies(chunk, {
    dialect: state.dialect,
    ...(state.variant === undefined ? {} : { variant: state.variant }),
    ...(state.version === undefined ? {} : { version: state.version }),
  });
}

/**
 * Evaluates a guard's declarative targets/exceptions against a dialect
 * identity — the same fail-closed semantics the renderer applies to `guard`
 * chunks, exposed so capability declarations ({@link dialectGuard} data and
 * the core capability registry) can be queried without rendering: a
 * variant-narrowed target matches only that variant, and a `minVersion`
 * exception lifts the guard only when the identity's version is **known**
 * and at least the floor.
 */
export function dialectGuardApplies(
  spec: {
    readonly unsupported: readonly DialectGuardTarget[];
    readonly unless?: readonly DialectGuardException[];
  },
  identity: SqlDialect | DialectIdentity,
): boolean {
  const resolved = toDialectIdentity(identity);
  const targeted = spec.unsupported.some((target) => {
    if (typeof target === "string") {
      return target === resolved.dialect;
    }
    if (target.dialect !== resolved.dialect) {
      return false;
    }
    return target.variant === undefined || target.variant === resolved.variant;
  });
  if (!targeted) {
    return false;
  }
  const lifted = (spec.unless ?? []).some((exception) => {
    if (
      exception.dialect !== undefined && exception.dialect !== resolved.dialect
    ) {
      return false;
    }
    if (
      exception.variant !== undefined && exception.variant !== resolved.variant
    ) {
      return false;
    }
    if (exception.baseEngine === true && resolved.variant !== undefined) {
      return false;
    }
    if (exception.minVersion !== undefined) {
      if (resolved.version === undefined) {
        return false;
      }
      if (compareServerVersions(resolved.version, exception.minVersion) < 0) {
        return false;
      }
    }
    return true;
  });
  return !lifted;
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
 * constructs a dialect cannot express (`distinctOn`, row locking, array
 * operators on the SQLite family; those plus `RETURNING`, `UPDATE … FROM`,
 * and data-modifying CTEs on MySQL) with a clear, typed error before they
 * reach the engine as invalid SQL.
 *
 * Targets and exceptions are declarative data, keeping guard chunks
 * serializable: a target may narrow to one engine `variant`, and
 * `options.unless` lifts the guard for identities matching a
 * {@link DialectGuardException} (e.g. `RETURNING` unsupported on `"mysql"`
 * unless `{ variant: "mariadb", minVersion: "10.5" }`). Version-gated
 * exceptions require a **known** server version — an unidentified server
 * stays guarded (fail closed).
 */
export function dialectGuard(
  construct: string,
  unsupported: readonly DialectGuardTarget[],
  options: { readonly unless?: readonly DialectGuardException[] } = {},
): Sql {
  return makeSql([{
    kind: "guard",
    construct,
    unsupported,
    ...(options.unless === undefined ? {} : { unless: options.unless }),
  }]);
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

/** Creates a condition wrapper around a SQL predicate fragment. */
export function createCondition(conditionSql: Sql): Condition {
  return Object.freeze({
    kind: "condition",
    sql: conditionSql,
  });
}

/** Asserts that a value is a Sisal condition. */
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

/** Converts a column-like operand into a SQL fragment. */
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

/** Returns true when a value is a non-null record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Clones rendered SQL text, parameters, and result metadata. */
export function cloneSqlQuery(query: SqlQuery): SqlQuery {
  const cloned = {
    text: query.text,
    params: [...query.params],
  };
  copyResultMetadata(query, cloned);
  return cloned;
}
