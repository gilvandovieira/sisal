/**
 * Filter operators, ordering helpers, and aggregate expressions used to build
 * `Condition`s and projections (Drizzle-style `eq`/`and`/`inArray`/`count`).
 *
 * Part of the `@sisal/orm` core; re-exported through `./mod.ts`.
 */

import { OrmError } from "./errors.ts";
import {
  assertCondition,
  assertSubquery,
  columnToSql,
  type Condition,
  createCondition,
  isColumn,
  isQueryBuilder,
  joinSql,
  operatorSql,
  raw,
  type Sql,
  sql,
  type SqlExpression,
  type SubquerySource,
  subquerySql,
} from "./sql.ts";

/** `column = value` SQL condition. */
export function eq(column: unknown, value: unknown): Condition {
  return binaryCondition(column, "=", value);
}

/** `column <> value` SQL condition. */
export function ne(column: unknown, value: unknown): Condition {
  return binaryCondition(column, "<>", value);
}

/** `column > value` SQL condition. */
export function gt(column: unknown, value: unknown): Condition {
  return binaryCondition(column, ">", value);
}

/** `column >= value` SQL condition. */
export function gte(column: unknown, value: unknown): Condition {
  return binaryCondition(column, ">=", value);
}

/** `column < value` SQL condition. */
export function lt(column: unknown, value: unknown): Condition {
  return binaryCondition(column, "<", value);
}

/** `column <= value` SQL condition. */
export function lte(column: unknown, value: unknown): Condition {
  return binaryCondition(column, "<=", value);
}

/** `column LIKE value` SQL condition. */
export function like(column: unknown, value: unknown): Condition {
  return binaryCondition(column, "like", value);
}

/**
 * Case-insensitive `ILIKE` match. Renders `ILIKE` on Postgres and degrades to
 * the (case-insensitive) `LIKE` on SQLite/libSQL/MySQL, which have no `ILIKE`.
 */
export function ilike(column: unknown, value: unknown): Condition {
  return operatorCondition(column, "ilike", value);
}

/** `column NOT LIKE value` SQL condition. */
export function notLike(column: unknown, value: unknown): Condition {
  return binaryCondition(column, "not like", value);
}

/** Case-insensitive `NOT ILIKE`; degrades to `NOT LIKE` off Postgres. */
export function notIlike(column: unknown, value: unknown): Condition {
  return operatorCondition(column, "not ilike", value);
}

/** `column BETWEEN min AND max` SQL condition (inclusive). */
export function between(
  column: unknown,
  min: unknown,
  max: unknown,
): Condition {
  return betweenCondition(column, min, max, false);
}

/** `column NOT BETWEEN min AND max` SQL condition. */
export function notBetween(
  column: unknown,
  min: unknown,
  max: unknown,
): Condition {
  return betweenCondition(column, min, max, true);
}

/**
 * `column IN (...)`. Each value is a bound parameter. An empty array yields a
 * constant always-false condition (`1 = 0`) rather than invalid `IN ()` SQL, so
 * dynamic filters with no values are safe. A select builder renders as a
 * subquery (`column IN (select ...)`).
 */
export function inArray(
  column: unknown,
  values: readonly unknown[] | SubquerySource,
): Condition {
  return inArrayCondition(column, values, false);
}

/**
 * `column NOT IN (...)`. An empty array yields a constant always-true condition;
 * a select builder renders as a subquery.
 */
export function notInArray(
  column: unknown,
  values: readonly unknown[] | SubquerySource,
): Condition {
  return inArrayCondition(column, values, true);
}

/** `column IS NULL` SQL condition. */
export function isNull(column: unknown): Condition {
  return createCondition(sql`${columnToSql(column)} is null`);
}

/** `column IS NOT NULL` SQL condition. */
export function isNotNull(column: unknown): Condition {
  return createCondition(sql`${columnToSql(column)} is not null`);
}

/** `EXISTS (subquery)` — true when the subquery returns any row. */
export function exists(subquery: SubquerySource): Condition {
  assertSubquery(subquery);
  return createCondition(sql`exists ${subquery}`);
}

/** `NOT EXISTS (subquery)` — true when the subquery returns no rows. */
export function notExists(subquery: SubquerySource): Condition {
  assertSubquery(subquery);
  return createCondition(sql`not exists ${subquery}`);
}

/**
 * Postgres array `@>` — true when `column` contains every element of `value`.
 * SQLite/libSQL/MySQL have no array containment operator.
 */
export function arrayContains(column: unknown, value: unknown): Condition {
  return binaryCondition(column, "@>", value);
}

/** Postgres array `<@` — true when `column` is contained by `value`. */
export function arrayContained(column: unknown, value: unknown): Condition {
  return binaryCondition(column, "<@", value);
}

/** Postgres array `&&` — true when `column` and `value` share any element. */
export function arrayOverlaps(column: unknown, value: unknown): Condition {
  return binaryCondition(column, "&&", value);
}

/** Combines conditions with SQL `AND`, ignoring nullish values. */
export function and(
  ...conditions: Array<Condition | null | undefined>
): Condition {
  return combineConditions("and", conditions);
}

/** Combines conditions with SQL `OR`, ignoring nullish values. */
export function or(
  ...conditions: Array<Condition | null | undefined>
): Condition {
  return combineConditions("or", conditions);
}

/** Negates a SQL condition with `NOT (...)`. */
export function not(condition: Condition): Condition {
  assertCondition(condition);
  return createCondition(sql`not (${condition.sql})`);
}

/** Ascending order term for `orderBy`, e.g. `orderBy(asc(users.columns.name))`. */
export function asc(column: unknown): Sql {
  return sql`${columnToSql(column)} asc`;
}

/** Descending order term for `orderBy`, e.g. `orderBy(desc(users.columns.id))`. */
export function desc(column: unknown): Sql {
  return sql`${columnToSql(column)} desc`;
}

/** `count(*)` (no argument) or `count(column)` aggregate expression. */
export function count(column?: unknown): SqlExpression<number> {
  const target = column === undefined ? raw("*") : columnToSql(column);
  return sql`count(${target})` as SqlExpression<number>;
}

/** `count(distinct column)` aggregate expression. */
export function countDistinct(column: unknown): SqlExpression<number> {
  return sql`count(distinct ${columnToSql(column)})` as SqlExpression<number>;
}

/** `sum(column)` aggregate expression. */
export function sum(column: unknown): SqlExpression<number | null> {
  return sql`sum(${columnToSql(column)})` as SqlExpression<number | null>;
}

/** `avg(column)` aggregate expression. */
export function avg(column: unknown): SqlExpression<number | null> {
  return sql`avg(${columnToSql(column)})` as SqlExpression<number | null>;
}

/** `min(column)` aggregate expression. */
export function min<T = unknown>(column: unknown): SqlExpression<T | null> {
  return sql`min(${columnToSql(column)})` as SqlExpression<T | null>;
}

/** `max(column)` aggregate expression. */
export function max<T = unknown>(column: unknown): SqlExpression<T | null> {
  return sql`max(${columnToSql(column)})` as SqlExpression<T | null>;
}

function binaryCondition(
  column: unknown,
  operator: string,
  value: unknown,
): Condition {
  // A column value renders as a column reference (e.g. join `ON a.x = b.y`);
  // anything else is bound as a parameter.
  const right = isColumn(value) ? columnToSql(value) : value;
  return createCondition(sql`${columnToSql(column)} ${raw(operator)} ${right}`);
}

// Like binaryCondition, but the operator is rendered per dialect (see
// renderOperator) — used by ilike/notIlike.
function operatorCondition(
  column: unknown,
  operator: string,
  value: unknown,
): Condition {
  const right = isColumn(value) ? columnToSql(value) : value;
  return createCondition(
    sql`${columnToSql(column)} ${operatorSql(operator)} ${right}`,
  );
}

function betweenCondition(
  column: unknown,
  min: unknown,
  max: unknown,
  negated: boolean,
): Condition {
  // Bounds render as column references when given columns, else bound params.
  const lower = isColumn(min) ? columnToSql(min) : min;
  const upper = isColumn(max) ? columnToSql(max) : max;
  return createCondition(
    sql`${columnToSql(column)} ${
      raw(negated ? "not between" : "between")
    } ${lower} and ${upper}`,
  );
}

function inArrayCondition(
  column: unknown,
  values: readonly unknown[] | SubquerySource,
  negated: boolean,
): Condition {
  if (isQueryBuilder(values)) {
    return createCondition(
      sql`${columnToSql(column)} ${raw(negated ? "not in" : "in")} ${
        subquerySql(values)
      }`,
    );
  }

  if (!Array.isArray(values)) {
    throw new OrmError("inArray requires an array of values", {
      code: "ORM_INVALID_QUERY",
    });
  }

  if (values.length === 0) {
    return createCondition(raw(negated ? "1 = 1" : "1 = 0"));
  }

  const list = joinSql(
    values.map((value) => sql`${value}`),
    raw(", "),
  );

  return createCondition(
    sql`${columnToSql(column)} ${raw(negated ? "not in" : "in")} (${list})`,
  );
}

function combineConditions(
  operator: "and" | "or",
  conditions: Array<Condition | null | undefined>,
): Condition {
  const validConditions = conditions.filter((
    condition,
  ): condition is Condition => condition !== undefined && condition !== null);

  if (validConditions.length === 0) {
    throw new OrmError("At least one condition is required", {
      code: "ORM_INVALID_QUERY",
      details: { operator },
    });
  }

  if (validConditions.length === 1) {
    return validConditions[0];
  }

  return createCondition(
    joinSql(
      validConditions.map((condition) => sql`(${condition.sql})`),
      // operator is a fixed SQL keyword (and/or), never user input.
      // deno-lint-ignore sisal/no-raw-interpolation
      raw(` ${operator} `),
    ),
  );
}
