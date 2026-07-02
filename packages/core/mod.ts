/**
 * `@sisal/core` — Sisal's driverless compile target: the schema primitives,
 * fragment SQL IR, expression operators, capability registry, and
 * dialect-aware renderer that every other Sisal package builds on.
 *
 * Extracted from `@sisal/orm`'s lower tier (v0.8 item 2). The fluent OLTP
 * query builders, `Database` facade, relations, and typed function caller
 * stay in `@sisal/orm`; downstream packages (`@sisal/etl`,
 * `@sisal/analytics`) compile into this surface without depending on the
 * ORM. `@sisal/orm/core`, `@sisal/orm/schema`, `@sisal/orm/error`, and
 * `@sisal/orm/logger` remain as compatibility re-exports.
 *
 * @module
 */

export * from "./error.ts";
export * from "./logger.ts";
export * from "./schema.ts";
export { assembleInsertFromSelect, assembleSelect } from "./assemble.ts";
export type {
  AssembleInsertFromSelectParts,
  AssembleSelectParts,
  AssembleUpsert,
} from "./assemble.ts";
export { OrmError } from "./errors.ts";
export type { OrmErrorCode, OrmErrorOptions } from "./errors.ts";
export {
  CAPABILITY_TARGETS,
  capabilityGuard,
  capabilitySupported,
  DIALECT_CAPABILITIES,
} from "./capabilities.ts";
export type {
  CapabilityTargetId,
  DialectCapability,
  SisalCapabilityId,
} from "./capabilities.ts";
export {
  compareServerVersions,
  dialectGuard,
  dialectGuardApplies,
  dialectSql,
  emptySql,
  expr,
  identifier,
  isColumn,
  isOrderTerm,
  isSql,
  isSqlQuery,
  joinSql,
  normalizeColumnName,
  normalizeSqlInput,
  normalizeTableName,
  placeholder,
  quoteIdentifier,
  raw,
  renderSql,
  serializeSqlValue,
  sql,
  SQL_IR_VERSION,
  sqlChunkMeta,
  toSql,
  withSqlChunkMeta,
} from "./sql.ts";
export type {
  ColumnName,
  Condition,
  DialectGuardException,
  DialectGuardTarget,
  DialectIdentity,
  InferProjection,
  OrderTerm,
  PlaceholderValues,
  SelectColumnRef,
  SelectProjection,
  SelectProjectionValue,
  Sql,
  SqlChunk,
  SqlChunkMeta,
  SqlDialect,
  SqlExpression,
  SqlInput,
  SqlParameter,
  SqlQuery,
  SubquerySource,
  TableName,
} from "./sql.ts";
export {
  and,
  arrayContained,
  arrayContains,
  arrayOverlaps,
  asc,
  avg,
  between,
  coalesce,
  count,
  countDistinct,
  dateAdd,
  dateBin,
  dateDiff,
  dateSub,
  dateTrunc,
  desc,
  eq,
  excluded,
  exists,
  filter,
  greatest,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  least,
  like,
  lt,
  lte,
  max,
  min,
  ne,
  not,
  notBetween,
  notExists,
  notIlike,
  notInArray,
  notLike,
  now,
  or,
  sum,
} from "./operators.ts";
export type {
  DateDiffField,
  DateDuration,
  DateTruncField,
} from "./operators.ts";
export { denseRank, lag, lead, over, rank, rowNumber } from "./window.ts";
export type { FrameBound, WindowFrame, WindowSpec } from "./window.ts";
export { arrayExpr, jsonExtract, jsonTable } from "./json.ts";
export type {
  JsonTable,
  JsonTableColumnSpec,
  JsonTableOptions,
} from "./json.ts";
export { columns, createColumn } from "./columns.ts";
export type {
  ColumnArray,
  ColumnBuilder,
  ColumnDataType,
  ColumnDefinition,
  ColumnRuntimeType,
  ColumnValueMode,
  CustomColumnTypeOptions,
  DateColumnMode,
  ReferentialAction,
  ReferentialOptions,
  TimeColumnMode,
  TimestampColumnMode,
} from "./columns.ts";
export { normalizeTemporalSqlValue } from "./temporal.ts";
export type { TemporalParsingOptions, TemporalSqlValue } from "./temporal.ts";
export {
  check,
  createSchemaSnapshot,
  defineTable,
  getDefaultColumnNaming,
  getTableColumns,
  getTableName,
  index,
  isTable,
  primaryKey,
  setDefaultColumnNaming,
  unique,
  uniqueIndex,
} from "./table.ts";
export type {
  AnyTableDefinition,
  ColumnDefinitionFromBuilder,
  ColumnNamingStrategy,
  CreateSchemaSnapshotInput,
  CreateSchemaSnapshotOptions,
  DefineTableOptions,
  IndexColumnSpec,
  IndexConstraintBuilder,
  InferInsert,
  InferSelect,
  TableColumn,
  TableColumns,
  TableConstraint,
  TableDefinition,
  UniqueConstraintBuilder,
} from "./table.ts";
