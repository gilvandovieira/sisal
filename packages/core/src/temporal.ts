/**
 * Temporal value normalization and opt-in result decoding.
 *
 * Sisal keeps the core driver contract primitive: Temporal values are converted
 * to ISO strings before they reach adapters. When a database facade opts into
 * Temporal parsing and a query carries ORM column metadata, rows are decoded
 * back into the semantic Temporal type for the selected column.
 */

import type { ColumnDefinition } from "./columns.ts";
import { OrmError } from "./errors.ts";

/** Options for Temporal result parsing in a database facade. */
export interface TemporalParsingOptions {
  /**
   * Decode known date/time result columns into Temporal values. Defaults to
   * `false`, preserving raw driver row values.
   */
  readonly parse?: boolean;
}

/** Temporal values accepted as SQL parameters. */
export type TemporalSqlValue =
  | Temporal.PlainDate
  | Temporal.PlainTime
  | Temporal.PlainDateTime
  | Temporal.Instant
  | Temporal.ZonedDateTime;

/** Column metadata used to decode one result field. */
export type ResultColumnMetadata = Pick<
  ColumnDefinition<unknown>,
  "array" | "dataType" | "valueMode"
>;

/** Result-field metadata keyed by output alias. */
export type ResultRowMetadata = Readonly<Record<string, ResultColumnMetadata>>;

/** Returns true when a value is one of the Temporal types Sisal supports. */
export function isTemporalSqlValue(value: unknown): value is TemporalSqlValue {
  if (typeof Temporal === "undefined" || value === null) {
    return false;
  }
  return value instanceof Temporal.PlainDate ||
    value instanceof Temporal.PlainTime ||
    value instanceof Temporal.PlainDateTime ||
    value instanceof Temporal.Instant ||
    value instanceof Temporal.ZonedDateTime;
}

/** True for the Temporal values whose serialization carries a `Z` suffix. */
export function isTemporalInstantValue(value: unknown): boolean {
  // Guard the global: `sql()` calls this on every interpolated value, so it must
  // not throw on runtimes without a `Temporal` global (e.g. Node < 25, Bun).
  if (typeof Temporal === "undefined") {
    return false;
  }
  return value instanceof Temporal.Instant ||
    value instanceof Temporal.ZonedDateTime;
}

/** Serializes a Temporal value into the string shape drivers can bind safely. */
export function serializeTemporalValue(value: TemporalSqlValue): string {
  if (value instanceof Temporal.ZonedDateTime) {
    return value.toInstant().toString();
  }
  return value.toString();
}

/** Normalizes Temporal values nested inside arrays before driver execution. */
export function normalizeTemporalSqlValue(value: unknown): unknown {
  if (isTemporalSqlValue(value)) {
    return serializeTemporalValue(value);
  }
  if (Array.isArray(value)) {
    const normalized = value.map(normalizeTemporalSqlValue);
    return normalized.some((item, index) => item !== value[index])
      ? normalized
      : value;
  }
  return value;
}

/** Decodes a result row when ORM column metadata is available. */
export function decodeTemporalRow(
  row: Record<string, unknown>,
  metadata: ResultRowMetadata,
): Record<string, unknown> {
  const decoded = { ...row };
  for (const [key, column] of Object.entries(metadata)) {
    if (!Object.hasOwn(decoded, key)) {
      continue;
    }
    decoded[key] = decodeColumnValue(decoded[key], column);
  }
  return decoded;
}

function decodeColumnValue(
  value: unknown,
  column: ResultColumnMetadata,
): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (column.array === true && Array.isArray(value)) {
    return value.map((item) => decodeScalarValue(item, column));
  }
  return decodeScalarValue(value, column);
}

function decodeScalarValue(
  value: unknown,
  column: ResultColumnMetadata,
): unknown {
  const mode = column.valueMode;
  if (mode === undefined || !isTemporalDataType(column.dataType)) {
    return value;
  }

  if (mode === "date") {
    return value;
  }

  if (mode === "string") {
    return stringifyTemporalColumnValue(value, column);
  }

  return parseTemporalColumnValue(value, column);
}

function stringifyTemporalColumnValue(
  value: unknown,
  column: ResultColumnMetadata,
): unknown {
  if (value instanceof Date) {
    const iso = value.toISOString();
    return column.dataType === "date" ? iso.slice(0, 10) : iso;
  }
  if (isTemporalSqlValue(value)) {
    return serializeTemporalValue(value);
  }
  return value;
}

function parseTemporalColumnValue(
  value: unknown,
  column: ResultColumnMetadata,
): unknown {
  try {
    switch (column.dataType) {
      case "date":
        return Temporal.PlainDate.from(dateText(value));
      case "time":
        return Temporal.PlainTime.from(timeText(value));
      case "timestamp":
        return Temporal.PlainDateTime.from(plainDateTimeText(value));
      case "timestamptz":
        return Temporal.Instant.from(instantText(value));
      default:
        return value;
    }
  } catch (error) {
    throw new OrmError("Temporal result value is invalid", {
      code: "ORM_SERIALIZATION_FAILED",
      details: { dataType: column.dataType },
      cause: error,
    });
  }
}

function isTemporalDataType(dataType: string): boolean {
  return dataType === "date" || dataType === "time" ||
    dataType === "timestamp" || dataType === "timestamptz";
}

function dateText(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  return text.split(/[T\s]/u)[0];
}

function timeText(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString().slice(11, 23);
  }
  const text = String(value).trim();
  const time = text.includes("T") ? text.split("T")[1] : text;
  return stripTimeZoneSuffix(time);
}

function plainDateTimeText(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString().replace("Z", "");
  }
  const text = String(value).trim().replace(" ", "T");
  return stripTimeZoneSuffix(text);
}

function instantText(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const text = String(value).trim();
  // A designator-less literal has exactly one sane instant reading: UTC.
  // Only the MySQL family produces these (its DATETIME/TIMESTAMP text has no
  // zone suffix; the adapter writes instants as naive UTC) — PostgreSQL
  // always renders an offset, so this branch never fires there.
  if (
    !/(?:[zZ]|[+-]\d{2}(?::?\d{2})?)$/u.test(text.replace(/\[[^\]]+\]$/u, ""))
  ) {
    return `${text.replace(" ", "T")}Z`;
  }
  return text;
}

function stripTimeZoneSuffix(value: string): string {
  return value
    .replace(/\[[^\]]+\]$/u, "")
    .replace(/(?:Z|[+-]\d{2}(?::?\d{2})?)$/u, "");
}
