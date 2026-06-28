/**
 * The column builder factory and immutable `ColumnBuilder`.
 *
 * Part of the `@sisal/orm` core; re-exported through `./mod.ts`.
 */

import { OrmError } from "./errors.ts";
import {
  type ColumnName,
  isRecord,
  normalizeColumnName,
  normalizeTableName,
} from "./sql.ts";

/** Column data types supported by the built-in column builder factory. */
export type ColumnDataType =
  | "text"
  | "varchar"
  | "char"
  | "integer"
  | "smallint"
  | "bigint"
  | "serial"
  | "bigserial"
  | "number"
  | "numeric"
  | "decimal"
  | "real"
  | "double"
  | "boolean"
  | "json"
  | "jsonb"
  | "date"
  | "time"
  | "timestamp"
  | "timestamptz"
  | "uuid"
  | "bytea"
  | (string & Record<never, never>);

/** JavaScript runtime value types represented by ORM columns. */
export type ColumnRuntimeType =
  | string
  | number
  | boolean
  | Date
  | Temporal.PlainDate
  | Temporal.PlainTime
  | Temporal.PlainDateTime
  | Temporal.Instant
  | null
  | Record<string, unknown>
  | unknown[];

/** Runtime value mode for date/time-ish columns. */
export type ColumnValueMode = "temporal" | "date" | "string";

/** Runtime modes for SQL `date` columns. */
export type DateColumnMode = "temporal" | "date" | "string";

/** Runtime modes for SQL `time` columns. */
export type TimeColumnMode = "temporal" | "string";

/** Runtime modes for SQL `timestamp` / `timestamptz` columns. */
export type TimestampColumnMode = "temporal" | "date" | "string";

/** A foreign-key referential action for `ON DELETE` / `ON UPDATE`. */
export type ReferentialAction =
  | "cascade"
  | "restrict"
  | "no action"
  | "set null"
  | "set default";

/** Options accepted by {@link ColumnBuilder.references}. */
export interface ReferentialOptions {
  readonly onDelete?: ReferentialAction;
  readonly onUpdate?: ReferentialAction;
}

/** Column metadata used by table definitions and future adapters. */
export interface ColumnDefinition<T> {
  readonly name?: ColumnName;
  readonly dataType: ColumnDataType;
  readonly valueMode?: ColumnValueMode;
  readonly length?: number;
  readonly precision?: number;
  readonly scale?: number;
  readonly array?: boolean;
  readonly dialectType?: string;
  readonly nullable: boolean;
  readonly hasDefault: boolean;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  readonly references?: {
    readonly table: string;
    readonly column: string;
    readonly onDelete?: ReferentialAction;
    readonly onUpdate?: ReferentialAction;
  };
  readonly defaultValue?: T | (() => T);
  readonly onUpdate?: () => unknown;
}

/**
 * Trusted custom column type metadata for {@link columns.customType}.
 *
 * `dialectType` is emitted verbatim by dialects that support it (currently
 * Postgres DDL), so only pass developer-authored schema literals.
 */
export interface CustomColumnTypeOptions {
  /** Dialect-neutral type kind kept in the serializable schema snapshot. */
  readonly kind: string;
  /** Raw dialect type emitted verbatim into DDL instead of `kind`. */
  readonly dialectType?: string;
  readonly length?: number;
  readonly precision?: number;
  readonly scale?: number;
}

/** Immutable column builder used to define table schemas. */
export interface ColumnBuilder<
  T,
  TOptional extends boolean = false,
  THasDefault extends boolean = false,
> {
  readonly definition: ColumnDefinition<T>;
  readonly optionalInsert: TOptional;
  readonly defaultInsert: THasDefault;

  named(name: string): ColumnBuilder<T, TOptional, THasDefault>;
  notNull(): ColumnBuilder<NonNullable<T>, TOptional, THasDefault>;
  nullable(): ColumnBuilder<T | null, TOptional, THasDefault>;
  optional(): ColumnBuilder<T | undefined, true, THasDefault>;
  default(value: T | (() => T)): ColumnBuilder<T, TOptional, true>;
  /** Adds the column to the primary key. Implies `.notNull()`. */
  primaryKey(): ColumnBuilder<NonNullable<T>, TOptional, THasDefault>;
  unique(): ColumnBuilder<T, TOptional, THasDefault>;
  references(
    table: string,
    column: string,
    options?: ReferentialOptions,
  ): ColumnBuilder<T, TOptional, THasDefault>;
  /** Makes the column an array of its element type (Postgres `type[]`). */
  array(): ColumnBuilder<ColumnArray<T>, TOptional, THasDefault>;
  /** Runs `fn` to produce a value applied on every `UPDATE` of the row. */
  $onUpdate(fn: () => NonNullable<T>): ColumnBuilder<T, TOptional, THasDefault>;
}

/** Array element/column type produced by {@link ColumnBuilder.array}. */
export type ColumnArray<T> = null extends T ? Array<NonNullable<T>> | null
  : Array<NonNullable<T>>;

/** The `columns` builder factory: one method per supported column type. */
interface ColumnsFactory {
  text(): ColumnBuilder<string | null>;
  /** Postgres `varchar`; pass `length` for `varchar(n)`. */
  varchar(length?: number): ColumnBuilder<string | null>;
  /** Postgres `char`; pass `length` for `char(n)`. */
  char(length?: number): ColumnBuilder<string | null>;
  integer(): ColumnBuilder<number | null>;
  smallint(): ColumnBuilder<number | null>;
  /** Postgres `bigint`. Typed as `string` to preserve 64-bit precision. */
  bigint(): ColumnBuilder<string | null>;
  /** Auto-incrementing `serial`; optional on insert. */
  serial(): ColumnBuilder<number | null, false, true>;
  /** Auto-incrementing `bigserial` (string-typed); optional on insert. */
  bigserial(): ColumnBuilder<string | null, false, true>;
  number(): ColumnBuilder<number | null>;
  /** Postgres `numeric`/`decimal`; string-typed to preserve precision. */
  numeric(precision?: number, scale?: number): ColumnBuilder<string | null>;
  /** Alias of {@link ColumnsFactory.numeric}. */
  decimal(precision?: number, scale?: number): ColumnBuilder<string | null>;
  real(): ColumnBuilder<number | null>;
  /** Postgres `double precision`. */
  doublePrecision(): ColumnBuilder<number | null>;
  boolean(): ColumnBuilder<boolean | null>;
  json<T = Record<string, unknown>>(): ColumnBuilder<T | null>;
  /** Postgres `jsonb`. */
  jsonb<T = Record<string, unknown>>(): ColumnBuilder<T | null>;
  date(): ColumnBuilder<Temporal.PlainDate | null>;
  date(
    options: { readonly mode: "temporal" },
  ): ColumnBuilder<Temporal.PlainDate | null>;
  date(options: { readonly mode: "date" }): ColumnBuilder<Date | null>;
  date(options: { readonly mode: "string" }): ColumnBuilder<string | null>;
  time(): ColumnBuilder<Temporal.PlainTime | null>;
  time(
    options: { readonly mode: "temporal" },
  ): ColumnBuilder<Temporal.PlainTime | null>;
  time(options: { readonly mode: "string" }): ColumnBuilder<string | null>;
  /** Postgres `timestamp`; `{ withTimezone: true }` maps to `timestamptz`. */
  timestamp(): ColumnBuilder<Temporal.PlainDateTime | null>;
  timestamp(
    options: { readonly mode: "temporal"; readonly withTimezone?: false },
  ): ColumnBuilder<Temporal.PlainDateTime | null>;
  timestamp(
    options: { readonly mode?: "temporal"; readonly withTimezone: true },
  ): ColumnBuilder<Temporal.Instant | null>;
  timestamp(
    options: { readonly mode: "temporal"; readonly withTimezone: boolean },
  ): ColumnBuilder<Temporal.PlainDateTime | Temporal.Instant | null>;
  timestamp(
    options: { readonly mode: "date"; readonly withTimezone?: boolean },
  ): ColumnBuilder<Date | null>;
  timestamp(
    options: { readonly mode: "string"; readonly withTimezone?: boolean },
  ): ColumnBuilder<string | null>;
  uuid(): ColumnBuilder<string | null>;
  /** Binary data: Postgres `bytea`, SQLite/libSQL `BLOB`. */
  bytea(): ColumnBuilder<Uint8Array | null>;
  /**
   * Trusted escape hatch for custom/dialect-specific column types.
   *
   * Example: `columns.customType<number[]>({ kind: "vector",
   * dialectType: "vector(1536)" })`.
   */
  customType<T = unknown>(
    options: CustomColumnTypeOptions,
  ): ColumnBuilder<T | null>;
}

/**
 * Column builder factory for table schemas.
 *
 * Columns are **nullable by default** (matching SQL and Drizzle); call
 * `.notNull()` to require a value. `.primaryKey()` implies `.notNull()`.
 */
export const columns: ColumnsFactory = Object.freeze({
  text(): ColumnBuilder<string | null> {
    return createColumnBuilder<string>("text");
  },

  varchar(length?: number): ColumnBuilder<string | null> {
    return createColumnBuilder<string>(
      "varchar",
      length === undefined ? {} : { length },
    );
  },

  char(length?: number): ColumnBuilder<string | null> {
    return createColumnBuilder<string>(
      "char",
      length === undefined ? {} : { length },
    );
  },

  integer(): ColumnBuilder<number | null> {
    return createColumnBuilder<number>("integer");
  },

  smallint(): ColumnBuilder<number | null> {
    return createColumnBuilder<number>("smallint");
  },

  bigint(): ColumnBuilder<string | null> {
    return createColumnBuilder<string>("bigint");
  },

  serial(): ColumnBuilder<number | null, false, true> {
    return createSerialBuilder<number>("serial");
  },

  bigserial(): ColumnBuilder<string | null, false, true> {
    return createSerialBuilder<string>("bigserial");
  },

  number(): ColumnBuilder<number | null> {
    return createColumnBuilder<number>("number");
  },

  numeric(precision?: number, scale?: number): ColumnBuilder<string | null> {
    return createColumnBuilder<string>(
      "numeric",
      numericExtra(precision, scale),
    );
  },

  decimal(precision?: number, scale?: number): ColumnBuilder<string | null> {
    return createColumnBuilder<string>(
      "decimal",
      numericExtra(precision, scale),
    );
  },

  real(): ColumnBuilder<number | null> {
    return createColumnBuilder<number>("real");
  },

  doublePrecision(): ColumnBuilder<number | null> {
    return createColumnBuilder<number>("double");
  },

  boolean(): ColumnBuilder<boolean | null> {
    return createColumnBuilder<boolean>("boolean");
  },

  json<T = Record<string, unknown>>(): ColumnBuilder<T | null> {
    return createColumnBuilder<T>("json");
  },

  jsonb<T = Record<string, unknown>>(): ColumnBuilder<T | null> {
    return createColumnBuilder<T>("jsonb");
  },

  date: dateColumn,

  time: timeColumn,

  timestamp: timestampColumn,

  uuid(): ColumnBuilder<string | null> {
    return createColumnBuilder<string>("uuid");
  },

  bytea(): ColumnBuilder<Uint8Array | null> {
    return createColumnBuilder<Uint8Array>("bytea");
  },

  customType<T = unknown>(
    options: CustomColumnTypeOptions,
  ): ColumnBuilder<T | null> {
    const normalized = normalizeCustomColumnTypeOptions(options);
    return createColumnBuilder<T>(normalized.kind, normalized);
  },
});

function dateColumn(): ColumnBuilder<Temporal.PlainDate | null>;
function dateColumn(
  options: { readonly mode: "temporal" },
): ColumnBuilder<Temporal.PlainDate | null>;
function dateColumn(
  options: { readonly mode: "date" },
): ColumnBuilder<Date | null>;
function dateColumn(
  options: { readonly mode: "string" },
): ColumnBuilder<string | null>;
function dateColumn(
  options: { readonly mode?: DateColumnMode } = {},
): ColumnBuilder<unknown | null> {
  return createColumnBuilder<unknown>("date", {
    valueMode: options.mode ?? "temporal",
  });
}

function timeColumn(): ColumnBuilder<Temporal.PlainTime | null>;
function timeColumn(
  options: { readonly mode: "temporal" },
): ColumnBuilder<Temporal.PlainTime | null>;
function timeColumn(
  options: { readonly mode: "string" },
): ColumnBuilder<string | null>;
function timeColumn(
  options: { readonly mode?: TimeColumnMode } = {},
): ColumnBuilder<unknown | null> {
  return createColumnBuilder<unknown>("time", {
    valueMode: options.mode ?? "temporal",
  });
}

function timestampColumn(): ColumnBuilder<Temporal.PlainDateTime | null>;
function timestampColumn(
  options: { readonly mode: "temporal"; readonly withTimezone?: false },
): ColumnBuilder<Temporal.PlainDateTime | null>;
function timestampColumn(
  options: { readonly mode?: "temporal"; readonly withTimezone: true },
): ColumnBuilder<Temporal.Instant | null>;
function timestampColumn(
  options: { readonly mode: "temporal"; readonly withTimezone: boolean },
): ColumnBuilder<Temporal.PlainDateTime | Temporal.Instant | null>;
function timestampColumn(
  options: { readonly mode: "date"; readonly withTimezone?: boolean },
): ColumnBuilder<Date | null>;
function timestampColumn(
  options: { readonly mode: "string"; readonly withTimezone?: boolean },
): ColumnBuilder<string | null>;
function timestampColumn(
  options: {
    readonly withTimezone?: boolean;
    readonly mode?: TimestampColumnMode;
  } = {},
): ColumnBuilder<unknown | null> {
  return createColumnBuilder<unknown>(
    options.withTimezone ? "timestamptz" : "timestamp",
    { valueMode: options.mode ?? "temporal" },
  );
}

/** Creates a named column definition from metadata. */
export function createColumn<T>(
  name: ColumnName,
  definition: ColumnDefinition<T>,
): ColumnDefinition<T> & { readonly name: ColumnName } {
  return Object.freeze({
    ...cloneColumnDefinition(definition),
    name: normalizeColumnName(name),
  });
}

class SisalColumnBuilder<
  T,
  TOptional extends boolean,
  THasDefault extends boolean,
> implements ColumnBuilder<T, TOptional, THasDefault> {
  readonly definition: ColumnDefinition<T>;
  readonly optionalInsert: TOptional;
  readonly defaultInsert: THasDefault;

  constructor(
    definition: ColumnDefinition<T>,
    optionalInsert: TOptional,
    defaultInsert: THasDefault,
  ) {
    this.definition = Object.freeze(cloneColumnDefinition(definition));
    this.optionalInsert = optionalInsert;
    this.defaultInsert = defaultInsert;
  }

  named(name: string): ColumnBuilder<T, TOptional, THasDefault> {
    return new SisalColumnBuilder(
      { ...this.definition, name: normalizeColumnName(name) },
      this.optionalInsert,
      this.defaultInsert,
    );
  }

  notNull(): ColumnBuilder<NonNullable<T>, TOptional, THasDefault> {
    return new SisalColumnBuilder(
      { ...this.definition, nullable: false } as ColumnDefinition<
        NonNullable<T>
      >,
      this.optionalInsert,
      this.defaultInsert,
    );
  }

  nullable(): ColumnBuilder<T | null, TOptional, THasDefault> {
    return new SisalColumnBuilder(
      { ...this.definition, nullable: true } as ColumnDefinition<T | null>,
      this.optionalInsert,
      this.defaultInsert,
    );
  }

  optional(): ColumnBuilder<T | undefined, true, THasDefault> {
    return new SisalColumnBuilder(
      this.definition as ColumnDefinition<T | undefined>,
      true,
      this.defaultInsert,
    );
  }

  default(value: T | (() => T)): ColumnBuilder<T, TOptional, true> {
    return new SisalColumnBuilder(
      {
        ...this.definition,
        hasDefault: true,
        defaultValue: value,
      },
      this.optionalInsert,
      true,
    );
  }

  primaryKey(): ColumnBuilder<NonNullable<T>, TOptional, THasDefault> {
    // A primary key is never null, so it implies NOT NULL.
    return new SisalColumnBuilder(
      {
        ...this.definition,
        primaryKey: true,
        nullable: false,
      } as ColumnDefinition<NonNullable<T>>,
      this.optionalInsert,
      this.defaultInsert,
    );
  }

  unique(): ColumnBuilder<T, TOptional, THasDefault> {
    return new SisalColumnBuilder(
      { ...this.definition, unique: true },
      this.optionalInsert,
      this.defaultInsert,
    );
  }

  references(
    table: string,
    column: string,
    options: ReferentialOptions = {},
  ): ColumnBuilder<T, TOptional, THasDefault> {
    return new SisalColumnBuilder(
      {
        ...this.definition,
        references: {
          table: normalizeTableName(table),
          column: normalizeColumnName(column),
          ...(options.onDelete === undefined
            ? {}
            : { onDelete: options.onDelete }),
          ...(options.onUpdate === undefined
            ? {}
            : { onUpdate: options.onUpdate }),
        },
      },
      this.optionalInsert,
      this.defaultInsert,
    );
  }

  array(): ColumnBuilder<ColumnArray<T>, TOptional, THasDefault> {
    return new SisalColumnBuilder(
      { ...this.definition, array: true } as ColumnDefinition<ColumnArray<T>>,
      this.optionalInsert,
      this.defaultInsert,
    );
  }

  $onUpdate(
    fn: () => NonNullable<T>,
  ): ColumnBuilder<T, TOptional, THasDefault> {
    return new SisalColumnBuilder(
      { ...this.definition, onUpdate: fn },
      this.optionalInsert,
      this.defaultInsert,
    );
  }
}

interface ColumnTypeExtra {
  readonly valueMode?: ColumnValueMode;
  readonly length?: number;
  readonly precision?: number;
  readonly scale?: number;
  readonly dialectType?: string;
}

function createColumnBuilder<T>(
  dataType: ColumnDataType,
  extra: ColumnTypeExtra = {},
): ColumnBuilder<T | null> {
  return new SisalColumnBuilder<T | null, false, false>(
    {
      dataType,
      ...(extra.valueMode === undefined ? {} : { valueMode: extra.valueMode }),
      ...(extra.length === undefined ? {} : { length: extra.length }),
      ...(extra.precision === undefined ? {} : { precision: extra.precision }),
      ...(extra.scale === undefined ? {} : { scale: extra.scale }),
      ...(extra.dialectType === undefined
        ? {}
        : { dialectType: extra.dialectType }),
      nullable: true,
      hasDefault: false,
      primaryKey: false,
      unique: false,
    },
    false,
    false,
  );
}

// Serial/bigserial are DB-generated, so they are optional on insert (THasDefault)
// without emitting a SQL DEFAULT clause.
function createSerialBuilder<T>(
  dataType: ColumnDataType,
): ColumnBuilder<T | null, false, true> {
  return new SisalColumnBuilder<T | null, false, true>(
    {
      dataType,
      nullable: true,
      hasDefault: false,
      primaryKey: false,
      unique: false,
    },
    false,
    true,
  );
}

function numericExtra(
  precision?: number,
  scale?: number,
): ColumnTypeExtra {
  return {
    ...(precision === undefined ? {} : { precision }),
    ...(scale === undefined ? {} : { scale }),
  };
}

function normalizeCustomColumnTypeOptions(
  options: CustomColumnTypeOptions,
): { readonly kind: ColumnDataType } & ColumnTypeExtra {
  if (!isRecord(options)) {
    throw new OrmError("customType requires an options object", {
      code: "ORM_INVALID_COLUMN",
    });
  }

  return {
    kind: normalizeCustomTypePart(options.kind, "kind"),
    ...(options.length === undefined ? {} : { length: options.length }),
    ...(options.precision === undefined
      ? {}
      : { precision: options.precision }),
    ...(options.scale === undefined ? {} : { scale: options.scale }),
    ...(options.dialectType === undefined ? {} : {
      dialectType: normalizeCustomTypePart(
        options.dialectType,
        "dialectType",
      ),
    }),
  };
}

function normalizeCustomTypePart(
  value: unknown,
  name: "kind" | "dialectType",
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OrmError(`customType ${name} must be a non-empty string`, {
      code: "ORM_INVALID_COLUMN",
      details: { [name]: value },
    });
  }

  return value;
}

export function cloneColumnDefinition<T>(
  definition: ColumnDefinition<T>,
): ColumnDefinition<T> {
  return {
    ...(definition.name === undefined ? {} : { name: definition.name }),
    dataType: definition.dataType,
    ...(definition.valueMode === undefined
      ? {}
      : { valueMode: definition.valueMode }),
    ...(definition.length === undefined ? {} : { length: definition.length }),
    ...(definition.precision === undefined
      ? {}
      : { precision: definition.precision }),
    ...(definition.scale === undefined ? {} : { scale: definition.scale }),
    ...(definition.array === undefined ? {} : { array: definition.array }),
    ...(definition.dialectType === undefined
      ? {}
      : { dialectType: definition.dialectType }),
    nullable: definition.nullable,
    hasDefault: definition.hasDefault,
    primaryKey: definition.primaryKey,
    unique: definition.unique,
    ...(definition.references === undefined ? {} : {
      references: {
        table: definition.references.table,
        column: definition.references.column,
        ...(definition.references.onDelete === undefined
          ? {}
          : { onDelete: definition.references.onDelete }),
        ...(definition.references.onUpdate === undefined
          ? {}
          : { onUpdate: definition.references.onUpdate }),
      },
    }),
    ...(definition.defaultValue === undefined
      ? {}
      : { defaultValue: definition.defaultValue }),
    ...(definition.onUpdate === undefined
      ? {}
      : { onUpdate: definition.onUpdate }),
  };
}

export function isColumnBuilder(
  value: unknown,
): value is ColumnBuilder<unknown> {
  return isRecord(value) && isRecord(value.definition) &&
    typeof value.named === "function" &&
    typeof value.notNull === "function";
}
