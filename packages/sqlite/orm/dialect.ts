import type { ColumnDataType, SqlDialect } from "@sisal/orm";

/** SQL dialect name used by the SQLite ORM adapter. */
export const SQLITE_DIALECT: SqlDialect = "sqlite";

/**
 * SQLite storage-class affinity for a Sisal {@link ColumnDataType}.
 *
 * SQLite has five affinities — `TEXT`, `INTEGER`, `REAL`, `NUMERIC`, `BLOB` —
 * and is dynamically typed, so higher-level types map onto the closest storage
 * class: dates/JSON/UUIDs are stored as `TEXT`, booleans as `INTEGER` (`0`/`1`).
 * This is the mapping the SQLite DDL generator and value coercion build on.
 */
export function sqliteColumnAffinity(dataType: ColumnDataType): string {
  switch (dataType) {
    case "integer":
    case "bigint":
    case "boolean":
      return "INTEGER";
    case "number":
      return "REAL";
    case "text":
    case "varchar":
    case "uuid":
    case "json":
    case "jsonb":
    case "date":
    case "timestamp":
    case "timestamptz":
      return "TEXT";
    default:
      return "TEXT";
  }
}
