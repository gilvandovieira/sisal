/**
 * JSON / array expression primitives (v0.8 item 14). Array construction and
 * scalar JSON extraction are portable *abstractions* that compile to each
 * engine's native function; the set-returning `jsonTable` FROM source is a
 * core compile-target primitive that composes with the ORM's raw
 * `.from(Sql)` overload and `assembleSelect`.
 *
 * @module
 */

import { OrmError } from "./errors.ts";
import {
  columnToSql,
  dialectSql,
  expr,
  identifier,
  isColumn,
  isSql,
  joinSql,
  raw,
  type Sql,
  sql,
  type SqlExpression,
} from "./sql.ts";

/**
 * Array construction — `ARRAY[a, b, c]` on PostgreSQL/generic, `JSON_ARRAY(…)`
 * on the MySQL family and SQLite (which have no native array type, so the
 * array round-trips as JSON text there — the documented value shape). Columns
 * and expressions render as SQL; plain values bind as parameters.
 */
export function arrayExpr<T = unknown>(
  ...values: readonly unknown[]
): SqlExpression<T[]> {
  const items = joinSql(
    values.map((v) => (isColumn(v) || isSql(v) ? columnToSql(v) : sql`${v}`)),
    raw(", "),
  );
  return expr<T[]>(dialectSql("arrayExpr", {
    postgres: sql`array[${items}]`,
    generic: sql`array[${items}]`,
    mysql: sql`json_array(${items})`,
    sqlite: sql`json_array(${items})`,
  }));
}

/**
 * Scalar JSON extraction at a JSONPath — `col ->> '$.a.b'` semantics as a
 * portable text-typed expression: PostgreSQL `jsonb_extract_path_text(col,
 * 'a', 'b')`, the MySQL family `json_unquote(json_extract(col, '$.a.b'))`,
 * SQLite `json_extract(col, '$.a.b')`. `path` is a JSONPath string (`$.a.b`)
 * — a trusted, developer-authored literal, emitted verbatim.
 */
export function jsonExtract(
  source: unknown,
  path: string,
): SqlExpression<string | null> {
  if (!path.startsWith("$")) {
    throw new OrmError("jsonExtract path must start with '$' (e.g. $.a.b)", {
      code: "ORM_INVALID_SQL",
      details: { path },
    });
  }
  const src = columnToSql(source);
  const pathSql = sqlStringLiteral(path);
  // PostgreSQL: turn `$.a.b` into the variadic text-path form.
  const pgKeys = path.slice(2).split(".").filter((k) => k.length > 0);
  const pgPath = joinSql(pgKeys.map(sqlStringLiteral), raw(", "));
  return expr<string | null>(dialectSql("jsonExtract", {
    postgres: sql`jsonb_extract_path_text(${src}, ${pgPath})`,
    mysql: sql`json_unquote(json_extract(${src}, ${pathSql}))`,
    sqlite: sql`json_extract(${src}, ${pathSql})`,
  }));
}

// A single-quoted SQL string literal for a trusted, developer-authored
// JSONPath (escaped). JSON functions take the path as a string literal, not a
// bound parameter, so it must render inline.
export function sqlStringLiteral(text: string): Sql {
  // deno-lint-ignore sisal/no-raw-interpolation
  return raw(`'${text.replace(/'/g, "''")}'`);
}

/** A projected column of a {@link jsonTable} — its logical type and JSONPath. */
export interface JsonTableColumnSpec {
  readonly type: "text" | "integer" | "bigint" | "double";
  /** JSONPath to the field within each array element, e.g. `$.sku`. */
  readonly path: string;
}

/** Options for {@link jsonTable}. */
export interface JsonTableOptions {
  /** FROM alias for the set-returning function (default `"jt"`). */
  readonly as?: string;
  /** JSONPath to the array inside `source` (default `$` — source is the array). */
  readonly path?: string;
}

/** The result of {@link jsonTable}: typed column refs + the FROM fragment. */
export interface JsonTable<
  TColumns extends Record<string, JsonTableColumnSpec>,
> {
  readonly columns: {
    readonly [K in keyof TColumns]: SqlExpression<
      TColumns[K]["type"] extends "text" ? string | null : number | null
    >;
  };
  /** The set-returning FROM fragment (`… as alias`) for `.from(...)`. */
  readonly from: Sql;
}

const JSON_TABLE_TYPE = {
  text: { postgres: "text", mysql: "varchar(255)" },
  integer: { postgres: "integer", mysql: "int" },
  bigint: { postgres: "bigint", mysql: "bigint" },
  double: { postgres: "double precision", mysql: "double" },
} as const;

// `$.a.b` -> Postgres text-path array literal `{a,b}` (for `#>`); `$` -> empty.
function pgPathArray(path: string): readonly string[] {
  return path === "$"
    ? []
    : path.slice(2).split(".").filter((k) => k.length > 0);
}

/**
 * A set-returning JSON-table over an array field — the portable *abstraction*
 * compiling to each engine's native function (contract 10): PostgreSQL
 * `jsonb_to_recordset` with a typed column list, the MySQL family `JSON_TABLE`
 * with a `COLUMNS(...)` clause, and SQLite `json_each` with per-field
 * `json_extract` (values come back as text — the documented SQLite JSON value
 * shape). Returns typed column references plus the FROM fragment, and
 * reference the exploded fields via `jt.columns.<name>`.
 *
 * When `source` is a **table column**, that table must also be in scope, so
 * join it with the function (the contract-10 lateral cross-join):
 * `.from(sql\`${orders}, ${jt.from}\`)` (or an explicit join). When `source`
 * is a standalone value/parameter, `.from(jt.from)` or
 * `assembleSelect({ from: jt.from })` works on its own.
 *
 * The `path`/`spec.path` JSONPaths are trusted, developer-authored literals
 * emitted verbatim.
 */
export function jsonTable<
  TColumns extends Record<string, JsonTableColumnSpec>,
>(
  source: unknown,
  spec: TColumns,
  options: JsonTableOptions = {},
): JsonTable<TColumns> {
  const alias = options.as ?? "jt";
  const arrayPath = options.path ?? "$";
  const aliasSql = identifier(alias);
  const src = columnToSql(source);
  const entries = Object.entries(spec);
  if (entries.length === 0) {
    throw new OrmError("jsonTable requires at least one column", {
      code: "ORM_INVALID_QUERY",
    });
  }

  // Per-dialect projection references.
  const columnRefs: Record<string, SqlExpression<string | number | null>> = {};
  for (const [name, col] of entries) {
    columnRefs[name] = expr(dialectSql(`jsonTable column ${name}`, {
      postgres: sql`${aliasSql}.${identifier(name)}`,
      generic: sql`${aliasSql}.${identifier(name)}`,
      mysql: sql`${aliasSql}.${identifier(name)}`,
      sqlite: sql`json_extract(${aliasSql}.${identifier("value")}, ${
        sqlStringLiteral(col.path)
      })`,
    }));
  }

  // Postgres: jsonb_to_recordset(<array>) as alias(col type, ...)
  const pgKeys = pgPathArray(arrayPath);
  const pgArray = pgKeys.length === 0
    ? src
    : sql`${src} #> ${sqlStringLiteral(`{${pgKeys.join(",")}}`)}`;
  const pgColumns = joinSql(
    entries.map(([name, col]) =>
      sql`${identifier(name)} ${raw(JSON_TABLE_TYPE[col.type].postgres)}`
    ),
    raw(", "),
  );
  const pgFrom =
    sql`jsonb_to_recordset(${pgArray}) as ${aliasSql}(${pgColumns})`;

  // MySQL: json_table(<src>, '<path>[*]' columns(col type path '<p>', ...)) as a
  const mysqlPath = arrayPath === "$" ? "$[*]" : `${arrayPath}[*]`;
  const mysqlColumns = joinSql(
    entries.map(([name, col]) =>
      sql`${identifier(name)} ${raw(JSON_TABLE_TYPE[col.type].mysql)} path ${
        sqlStringLiteral(col.path)
      }`
    ),
    raw(", "),
  );
  const mysqlFrom = sql`json_table(${src}, ${sqlStringLiteral(mysqlPath)} ${
    raw("columns")
  } (${mysqlColumns})) as ${aliasSql}`;

  // SQLite: json_each(<src>[, '<path>']) as alias — fields extracted in the
  // projection refs above.
  const sqliteFrom = arrayPath === "$"
    ? sql`json_each(${src}) as ${aliasSql}`
    : sql`json_each(${src}, ${sqlStringLiteral(arrayPath)}) as ${aliasSql}`;

  const from = dialectSql("jsonTable", {
    postgres: pgFrom,
    generic: pgFrom,
    mysql: mysqlFrom,
    sqlite: sqliteFrom,
  });

  return {
    columns: columnRefs as JsonTable<TColumns>["columns"],
    from,
  };
}
