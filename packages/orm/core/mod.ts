/**
 * Typed SQL builders and ORM driver contracts for `@sisal/orm`.
 *
 * @module
 */

export { OrmError } from "./errors.ts";
export type { OrmErrorCode, OrmErrorOptions } from "./errors.ts";
export {
  emptySql,
  identifier,
  isColumn,
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
  toSql,
} from "./sql.ts";
export type {
  ColumnName,
  Condition,
  InferProjection,
  PlaceholderValues,
  SelectColumnRef,
  SelectProjection,
  SelectProjectionValue,
  Sql,
  SqlChunk,
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
  count,
  countDistinct,
  desc,
  eq,
  exists,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
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
  or,
  sum,
} from "./operators.ts";
export { columns, createColumn } from "./columns.ts";
export type {
  ColumnArray,
  ColumnBuilder,
  ColumnDataType,
  ColumnDefinition,
  ColumnRuntimeType,
  CustomColumnTypeOptions,
  ReferentialAction,
  ReferentialOptions,
} from "./columns.ts";
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
  IndexConstraintBuilder,
  InferInsert,
  InferSelect,
  TableColumn,
  TableColumns,
  TableConstraint,
  TableDefinition,
  UniqueConstraintBuilder,
} from "./table.ts";
export type {
  CompoundSelectBuilder,
  Cte,
  CteBuilder,
  DeleteBuilder,
  ForLockOptions,
  InsertBuilder,
  PreparedQuery,
  SelectBuilder,
  SetOperand,
  Subquery,
  UpdateBuilder,
  WithQueryBuilder,
} from "./builders.ts";
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
export { createDatabase, memoryOrmDriver, noopOrmDriver } from "./database.ts";
export type {
  Database,
  DatabaseOptions,
  DatabaseQuery,
  DatabaseSchema,
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
//   createdAt: columns.timestamp().default(() => new Date()),
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
//   createdAt: new Date(),
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
//     createdAt: new Date(),
//   }).execute();
// });
