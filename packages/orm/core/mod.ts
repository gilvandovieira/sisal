/**
 * Typed SQL builders and ORM driver contracts for `@sisal/orm`.
 *
 * @module
 */

export { OrmError } from "@sisal/core";
export type { OrmErrorCode, OrmErrorOptions } from "@sisal/core";
export { assembleInsertFromSelect, assembleSelect } from "@sisal/core";
export type {
  AssembleInsertFromSelectParts,
  AssembleSelectParts,
  AssembleUpsert,
} from "@sisal/core";
export {
  CAPABILITY_TARGETS,
  capabilityGuard,
  capabilitySupported,
  DIALECT_CAPABILITIES,
} from "@sisal/core";
export type {
  CapabilityTargetId,
  DialectCapability,
  SisalCapabilityId,
} from "@sisal/core";
export {
  compareServerVersions,
  dialectGuard,
  dialectGuardApplies,
  dialectSql,
  emptySql,
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
} from "@sisal/core";
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
} from "@sisal/core";
export {
  and,
  arrayContained,
  arrayContains,
  arrayExpr,
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
  denseRank,
  desc,
  eq,
  excluded,
  exists,
  expr,
  filter,
  greatest,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  jsonExtract,
  jsonTable,
  lag,
  lead,
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
  over,
  rank,
  rowNumber,
  sum,
} from "@sisal/core";
export type {
  DateDiffField,
  DateDuration,
  DateTruncField,
  FrameBound,
  WindowFrame,
  WindowSpec,
} from "@sisal/core";
export { columns, createColumn } from "@sisal/core";
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
} from "@sisal/core";
export { normalizeTemporalSqlValue } from "@sisal/core";
export type { TemporalParsingOptions, TemporalSqlValue } from "@sisal/core";
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
} from "@sisal/core";
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
} from "@sisal/core";
export type {
  CompoundSelectBuilder,
  Cte,
  CteBuilder,
  CteOperand,
  DeleteBuilder,
  ForLockOptions,
  InsertBuilder,
  InsertValues,
  KeysetCursor,
  KeysetKeys,
  KeysetOptions,
  KeysetPage,
  KeysetSelectBuilder,
  PreparedQuery,
  RecursiveCteBuilder,
  SelectBuilder,
  SetOperand,
  Subquery,
  UpdateBuilder,
  UpdateValues,
  WithQueryBuilder,
} from "./builders.ts";
export { defineFunction } from "./functions.ts";
export type {
  FunctionArgsConfig,
  FunctionArgsInput,
  FunctionCall,
  FunctionConfig,
  FunctionDefinition,
  FunctionReturnsConfig,
  FunctionRow,
} from "./functions.ts";
export { relations } from "./relations.ts";
export type {
  RelationalColumnSelection,
  RelationalFindOptions,
  RelationalQueryResult,
  RelationalTableQuery,
  RelationConfig,
  RelationDefinition,
  RelationDefinitionMap,
  RelationHelpers,
  RelationMode,
  RelationsList,
  TableRelations,
} from "./relations.ts";
export {
  createDatabase,
  defineAtomicOperation,
  memoryOrmDriver,
  noopOrmDriver,
} from "./database.ts";
export { etlCheckpoint } from "./checkpoint.ts";
export { tryInsert } from "./write_outcome.ts";
export type { WriteOutcome } from "./write_outcome.ts";
export type {
  Checkpoint,
  CheckpointOptions,
  CheckpointState,
  ReplayGuardOptions,
} from "./checkpoint.ts";
export type {
  AdvisoryLock,
  AdvisoryLockOptions,
  AtomicOperation,
  AtomicOperationBody,
  AtomicOperationConfig,
  BatchStatement,
  ColumnMap,
  ColumnMapping,
  Database,
  DatabaseOptions,
  DatabaseQuery,
  DatabaseSchema,
  MappableQueryResult,
  MemoryOrmDriverOptions,
  OrmDriver,
  OrmQueryResult,
  OrmTransaction,
  RawQueryExecutor,
} from "./database.ts";

// Examples:
//
// const users = defineTable("users", {
//   id: columns.text().primaryKey(),
//   name: columns.text().notNull(),
//   email: columns.text().notNull().unique(),
//   age: columns.integer().optional(),
//   createdAt: columns.timestamp({ withTimezone: true }).default(() =>
//     Temporal.Now.instant()
//   ),
// });
//
// type User = InferSelect<typeof users>;
// type NewUser = InferInsert<typeof users>;
//
// const db = createDatabase({
//   driver: noopOrmDriver(),
// });
//
// const rows = await db
//   .select()
//   .from(users)
//   .where(eq(users.columns.id, "u_123"))
//   .limit(1)
//   .execute();
//
// await db.insert(users).values({
//   id: "u_123",
//   name: "Lucas",
//   email: "lucas@example.com",
//   createdAt: Temporal.Now.instant(),
// }).execute();
//
// await db.update(users)
//   .set({ name: "Lucas Vieira" })
//   .where(eq(users.columns.id, "u_123"))
//   .execute();
//
// await db.delete(users)
//   .where(eq(users.columns.id, "u_123"))
//   .execute();
//
// await db.execute(sql`
//   select *
//   from users
//   where id = ${"u_123"}
// `);
//
// await db.transaction(async (tx) => {
//   await tx.insert(users).values({
//     id: "u_456",
//     name: "Ana",
//     email: "ana@example.com",
//     createdAt: Temporal.Now.instant(),
//   }).execute();
// });
