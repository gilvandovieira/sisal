/**
 * Minimal deterministic statement assembly — the public seam the v0.8 item-5
 * decision exposed so downstream packages (`@sisal/etl`, `@sisal/analytics`)
 * can compose whole statements from core primitives **without depending on
 * `@sisal/orm`'s fluent builders**. Assemble-from-parts only: a `SELECT` from
 * clause parts, and an `INSERT … SELECT` with an optional dialect-mapped
 * upsert. The rendered SQL is byte-identical to the ORM builder's output for
 * the same statement (pinned by the assembly-equivalence tests), so the two
 * surfaces cannot drift.
 *
 * Anything beyond this shape — joins, CTE chains, mutations, keyset paging —
 * is the ORM builder's territory; compose fragments with the `sql` tag for
 * genuinely custom statements.
 *
 * @module
 */

import { OrmError } from "./errors.ts";
import {
  columnToSql,
  type Condition,
  dialectSql,
  emptySql,
  identifier,
  isOrderTerm,
  isSql,
  joinSql,
  raw,
  type Sql,
  sql,
} from "./sql.ts";
import {
  assertTable,
  assertTableColumn,
  isTable,
  type TableDefinition,
} from "./table.ts";

/**
 * Clause parts for {@link assembleSelect}. Projection values are columns or
 * expressions (each renders `value as "key"`); `groupBy`/`orderBy` accept
 * columns, expressions, or `asc()`/`desc()` terms; `limit` binds as a
 * parameter.
 */
export interface AssembleSelectParts {
  /** Projection map rendered in the `SELECT` clause. */
  readonly select: Readonly<Record<string, unknown>>;
  /** Source table or subquery rendered in the `FROM` clause. */
  readonly from: TableDefinition | Sql;
  /** Optional filtering predicate rendered as `WHERE`. */
  readonly where?: Condition;
  /** Optional grouping expressions rendered as `GROUP BY`. */
  readonly groupBy?: readonly unknown[];
  /** Optional grouped-result predicate rendered as `HAVING`. */
  readonly having?: Condition;
  /** Optional ordering terms rendered as `ORDER BY`. */
  readonly orderBy?: readonly unknown[];
  /** Optional row limit rendered as a bound parameter. */
  readonly limit?: number;
}

/**
 * The dialect-mapped upsert clause for {@link assembleInsertFromSelect}:
 * `ON CONFLICT (target) DO UPDATE SET …` on PostgreSQL/SQLite and
 * `ON DUPLICATE KEY UPDATE …` on the MySQL family (where the target is
 * validated but not rendered — ODKU fires on any unique-key violation).
 * `set` values are expressions; pair them with `excluded()` for the
 * proposed-row reference.
 */
export interface AssembleUpsert {
  /** Conflict-target columns of the destination table. */
  readonly target: readonly unknown[];
  /** Destination column key → new-value expression. */
  readonly set: Readonly<Record<string, unknown>>;
}

/** Parts for {@link assembleInsertFromSelect}. */
export interface AssembleInsertFromSelectParts {
  /** Destination table receiving rows from the source query. */
  readonly into: TableDefinition;
  /**
   * The source query; its projection keys name the destination columns
   * (`insert into t ("a", "b") select … as "a", … as "b"`).
   */
  readonly select: AssembleSelectParts;
  /** Optional dialect-mapped upsert clause for conflict handling. */
  readonly onConflictDoUpdate?: AssembleUpsert;
}

// Renders `value as "key"` for every projection entry — the same rule the
// ORM builder applies, so assembled and built statements stay byte-identical.
function projectionSql(select: AssembleSelectParts["select"]): Sql {
  const entries = Object.entries(select);
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

function listSql(items: readonly unknown[]): Sql {
  return joinSql(
    items.map((item) =>
      isOrderTerm(item) || isSql(item) ? item as Sql : columnToSql(item)
    ),
    raw(", "),
  );
}

/**
 * Assembles a `SELECT` statement from clause parts using only core
 * primitives. The v0.8 item-5 seam: deterministic, no builder state — the
 * compile target for downstream packages.
 */
export function assembleSelect(parts: AssembleSelectParts): Sql {
  const chunks: Sql[] = [
    sql`select ${projectionSql(parts.select)} from ${
      isTable(parts.from)
        ? identifier((parts.from as TableDefinition).name)
        : parts.from as Sql
    }`,
  ];
  if (parts.where !== undefined) {
    chunks.push(sql` where ${parts.where.sql}`);
  }
  if (parts.groupBy !== undefined && parts.groupBy.length > 0) {
    chunks.push(sql` group by ${listSql(parts.groupBy)}`);
  }
  if (parts.having !== undefined) {
    chunks.push(sql` having ${parts.having.sql}`);
  }
  if (parts.orderBy !== undefined && parts.orderBy.length > 0) {
    chunks.push(sql` order by ${listSql(parts.orderBy)}`);
  }
  if (parts.limit !== undefined) {
    chunks.push(sql` limit ${parts.limit}`);
  }
  return joinSql(chunks, emptySql());
}

// A conflict-target/destination column: a TableColumn of `table`, rendered
// unqualified. Accepts the column ref (typed) and validates membership.
function destinationColumnSql(
  table: TableDefinition,
  key: string,
): Sql {
  assertTableColumn(table, key);
  const column = table.columns[key] as { readonly name: string };
  return identifier(column.name);
}

function conflictTargetSql(table: TableDefinition, target: unknown): Sql {
  if (typeof target === "string") {
    return destinationColumnSql(table, target);
  }
  const column = target as {
    readonly name?: string;
    readonly propertyName?: string;
  };
  if (typeof column.propertyName === "string") {
    return destinationColumnSql(table, column.propertyName);
  }
  throw new OrmError("Upsert target must be a column of the target table", {
    code: "ORM_INVALID_QUERY",
  });
}

/**
 * Assembles `INSERT INTO t (columns) SELECT …` — the destination column list
 * derives from the select projection keys, mapped to the destination table's
 * physical names — with an optional dialect-mapped upsert
 * ({@link AssembleUpsert}). Byte-identical to the ORM builder's
 * `insert().select().onConflictDoUpdate()` render.
 */
export function assembleInsertFromSelect(
  parts: AssembleInsertFromSelectParts,
): Sql {
  assertTable(parts.into);
  const keys = Object.keys(parts.select.select);
  const columnList = joinSql(
    keys.map((key) => destinationColumnSql(parts.into, key)),
    raw(", "),
  );
  const chunks: Sql[] = [
    sql`insert into ${identifier(parts.into.name)} (${columnList}) ${
      assembleSelect(parts.select)
    }`,
  ];
  const conflict = parts.onConflictDoUpdate;
  if (conflict !== undefined) {
    const entries = Object.entries(conflict.set)
      .filter(([, value]) => value !== undefined);
    if (entries.length === 0) {
      throw new OrmError("onConflictDoUpdate requires set values", {
        code: "ORM_INVALID_QUERY",
      });
    }
    const setSql = joinSql(
      entries.map(([name, value]) =>
        sql`${destinationColumnSql(parts.into, name)} = ${value}`
      ),
    );
    const targetList = joinSql(
      conflict.target.map((target) => conflictTargetSql(parts.into, target)),
      raw(", "),
    );
    const conflictForm = joinSql([
      raw(" on conflict ("),
      targetList,
      raw(") do update set "),
      setSql,
    ], emptySql());
    // MySQL's ODKU fires on ANY unique-key violation: the target is
    // validated (membership, above) but cannot be rendered — the same
    // dialect mapping the ORM builder's C2 upsert applies.
    chunks.push(dialectSql("upsert", {
      mysql: sql` on duplicate key update ${setSql}`,
    }, conflictForm));
  }
  return joinSql(chunks, emptySql());
}
