/**
 * Unstable plumbing consumed by `@sisal/orm`'s query-builder tier — **not**
 * part of the documented `@sisal/core` compile target and not covered by its
 * stability commitment. Downstream packages must import from the package
 * root instead; these symbols exist so the fluent OLTP builders (which live
 * in `@sisal/orm`) can assemble statements over the fragment IR without the
 * IR internals becoming public API.
 *
 * @module
 */

export {
  assertCondition,
  attachResultMetadata,
  cloneSqlQuery,
  columnToSql,
  createCondition,
  fillPreparedPlan,
  getResultMetadata,
  isRecord,
  paramSql,
  QUERY_BUILDER_BRAND,
  renderToPlan,
} from "./sql.ts";
export type { PreparedPlan } from "./sql.ts";
export {
  decodeTemporalRow,
  isTemporalSqlValue,
  serializeTemporalValue,
} from "./temporal.ts";
export type { ResultColumnMetadata, ResultRowMetadata } from "./temporal.ts";
export { assertTable, assertTableColumn } from "./table.ts";
export { isColumnBuilder } from "./columns.ts";
