---
title: API Reference
---

# Sisal API Reference

Complete reference for the public API of every Sisal package, generated from a
full read of the source. Sisal is a Deno-first database toolkit, published to
JSR, made of six packages with strict boundaries:

| Package          | Import root      | Responsibility                                          |
| ---------------- | ---------------- | ------------------------------------------------------- |
| `@sisal/orm`     | `@sisal/orm`     | Driverless schema, typed SQL, query builders, snapshots |
| `@sisal/migrate` | `@sisal/migrate` | Adapter-neutral migration planning, running, workflow   |
| `@sisal/pg`      | `@sisal/pg`      | PostgreSQL execution, history, migrator, DDL            |
| `@sisal/neon`    | `@sisal/neon`    | Neon serverless PostgreSQL execution and migrations     |
| `@sisal/sqlite`  | `@sisal/sqlite`  | SQLite execution, history, migrator, DDL                |
| `@sisal/libsql`  | `@sisal/libsql`  | libSQL/Turso execution, history, migrator, SQLite DDL   |

The ORM never imports an adapter; adapters depend on `@sisal/orm`. See
[`drizzle-parity`](./drizzle-parity.html) for how this surface maps to Drizzle
ORM 0.45.2 and where it diverges on purpose.

> **Stability:** all packages are `0.3.0` (pre-1.0). The surface below is
> current but may change before 1.0.

---

## Subpath exports

Each package exposes narrower entry points so an app can import the smallest
boundary it needs.

```text
@sisal/orm            @sisal/migrate          @sisal/pg               @sisal/neon
  .   -> mod.ts         .        -> mod.ts       .       -> mod.ts       .       -> mod.ts
  ./core                ./cli                    ./orm                   ./orm
  ./error               ./core                   ./migrate               ./migrate
  ./logger                                       ./ddl                   ./ddl
  ./schema              ./workflow

@sisal/sqlite         @sisal/libsql
  .       -> mod.ts     .       -> mod.ts
  ./orm                ./orm
  ./migrate            ./migrate
  ./ddl                ./ddl
```

---

# @sisal/orm

Driverless. Owns schema definitions, typed SQL fragments, predicates, query
builders, the database facade, and serializable schema snapshots.

## Schema definition

### `defineTable(name, columns, extrasOrOptions?, options?)`

```ts
function defineTable<TColumns extends TableColumns>(
  name: string,
  columns: TColumns,
  extrasOrOptions?:
    | ((columns: TableDefinition<TColumns>["columns"]) => TableConstraint[])
    | { schema?: string },
  options?: { schema?: string },
): TableDefinition<TColumns>;
```

Defines a typed, frozen table. Column DB names default to the property key (or
`.named(...)` override). The optional extras callback defines table-level
indexes and constraints. Returns a `TableDefinition` whose `.columns[key]`
entries carry `name`, `tableName`, `propertyName`, and the resolved flags.

```ts
import { check, columns, defineTable, index, sql, unique } from "@sisal/orm";

const users = defineTable(
  "users",
  {
    id: columns.uuid().primaryKey(),
    email: columns.text().notNull().unique(),
    name: columns.text().notNull(),
    age: columns.integer().optional(),
    createdAt: columns.timestamp({ withTimezone: true }).default(() =>
      Temporal.Now.instant()
    ),
    orgId: columns.uuid().references("organizations", "id", {
      onDelete: "cascade",
    }),
  },
  (t) => [
    index("users_org_idx").on(t.orgId),
    unique("users_org_email_unique").on(t.orgId, t.email),
    check("users_age_check", sql`${t.age} >= ${0}`),
  ],
);

// Column references are reached through `.columns`:
users.columns.id; // { name: "id", tableName: "users", dataType: "uuid", ... }
```

Table-level helpers:

| Helper                         | Purpose                                   |
| ------------------------------ | ----------------------------------------- |
| `index(name?).on(...cols)`     | Non-unique index                          |
| `uniqueIndex(name?).on(...c)`  | Unique index                              |
| `primaryKey({ columns })`      | Composite/table-level primary key         |
| `unique(name?).on(...columns)` | Composite/table-level unique constraint   |
| `check(name, sql\`...\`)`      | Named check constraint from a SQL literal |

### `columns` — column builder factory

`columns` is a frozen object of constructors. Each returns an immutable
`ColumnBuilder`.

| Factory                               | Value type               | Notes                                                                      |
| ------------------------------------- | ------------------------ | -------------------------------------------------------------------------- |
| `columns.text()`                      | `string`                 |                                                                            |
| `columns.varchar(length?)`            | `string`                 | `varchar(n)` when `length` given                                           |
| `columns.char(length?)`               | `string`                 | `char(n)` when `length` given                                              |
| `columns.integer()`                   | `number`                 |                                                                            |
| `columns.smallint()`                  | `number`                 |                                                                            |
| `columns.bigint()`                    | `string`                 | string-typed to preserve 64-bit precision                                  |
| `columns.serial()`                    | `number`                 | auto-increment; optional on insert                                         |
| `columns.bigserial()`                 | `string`                 | auto-increment; optional on insert                                         |
| `columns.numeric(precision?, scale?)` | `string`                 | string-typed to preserve precision                                         |
| `columns.decimal(precision?, scale?)` | `string`                 | alias of `numeric`                                                         |
| `columns.real()`                      | `number`                 |                                                                            |
| `columns.doublePrecision()`           | `number`                 | Postgres `double precision`                                                |
| `columns.number()`                    | `number`                 | generic numeric                                                            |
| `columns.boolean()`                   | `boolean`                |                                                                            |
| `columns.json<T>()`                   | `T`                      | defaults `T = Record<string, unknown>`                                     |
| `columns.jsonb<T>()`                  | `T`                      | Postgres `jsonb`                                                           |
| `columns.date(options?)`              | `Temporal.PlainDate`     | `{ mode: "date" }` → `Date`; `{ mode: "string" }` → `string`               |
| `columns.time(options?)`              | `Temporal.PlainTime`     | `{ mode: "string" }` → `string`                                            |
| `columns.timestamp(options?)`         | `Temporal.PlainDateTime` | `{ withTimezone: true }` → `Temporal.Instant` / `timestamptz`; modes below |
| `columns.uuid()`                      | `string`                 |                                                                            |
| `columns.bytea()`                     | `Uint8Array`             | Postgres `bytea`; SQLite/libSQL `BLOB`                                     |
| `columns.customType<T>(options)`      | `T`                      | trusted dialect type escape hatch                                          |

Date/time columns use semantic Temporal types by default:

| SQL concept                   | Sisal column                                | Default JS type          |
| ----------------------------- | ------------------------------------------- | ------------------------ |
| `date`                        | `columns.date()`                            | `Temporal.PlainDate`     |
| `time`                        | `columns.time()`                            | `Temporal.PlainTime`     |
| `timestamp without time zone` | `columns.timestamp()`                       | `Temporal.PlainDateTime` |
| `timestamp with time zone`    | `columns.timestamp({ withTimezone: true })` | `Temporal.Instant`       |

Use `mode: "date"` to keep JS `Date` values where supported:
`columns.date({ mode: "date" })` or
`columns.timestamp({ withTimezone: true, mode: "date" })`. Use `mode: "string"`
when you want raw database/driver text. Temporal values are serialized to ISO
strings before adapters receive params; arrays are normalized recursively.
Result parsing is opt-in with `createDatabase({ temporal:
{ parse: true } })`;
without it, rows keep the driver-returned shape. The reusable mode types are
exported as `DateColumnMode`, `TimeColumnMode`, `TimestampColumnMode`, and
`ColumnValueMode`.

Migration notes for v0.4.0:

```ts
// Before: inferred Date; Postgres DDL emitted timestamptz.
createdAt: columns.timestamp();

// After: inferred Temporal.PlainDateTime; Postgres DDL emits timestamp.
createdAt: columns.timestamp();

// Keep instant semantics.
createdAt: columns.timestamp({ withTimezone: true });

// Keep legacy JS Date values.
createdAt: columns.timestamp({ withTimezone: true, mode: "date" });

// Keep raw string values.
createdAt: columns.timestamp({ withTimezone: true, mode: "string" });
```

Precision: Temporal can represent nanoseconds, PostgreSQL stores timestamps at
microsecond precision, and JS `Date` stores milliseconds. Sisal does not promise
nanosecond round-trips through any database. For keyset pagination over
date/time columns, prefer DB-returned cursor values and always include a unique
final tiebreaker such as a primary key.

`columns.customType<T>({ kind, dialectType })` preserves `kind` in snapshots and
lets Postgres DDL emit a trusted, developer-authored `dialectType` verbatim. Use
it for types such as `interval`, `vector(1536)`, `inet`, or identity syntax when
a dedicated Sisal factory does not exist.

### Column modifiers (`ColumnBuilder`)

All modifiers return a **new** builder (immutable chaining).

| Modifier                               | Effect                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------- |
| `.notNull()`                           | Requires a value (opt out of the nullable default)                          |
| `.nullable()`                          | Marks the column nullable (the default; explicit for readability)           |
| `.optional()`                          | Makes the field optional **on insert** (does not change nullability)        |
| `.default(value \| () => value)`       | Sets a default; also makes the field optional on insert                     |
| `.primaryKey()`                        | Adds the column to the primary key (implies `.notNull()`)                   |
| `.unique()`                            | Adds a single-column unique constraint                                      |
| `.references(table, column, options?)` | Adds a single-column foreign key; `options` accepts `onDelete` / `onUpdate` |
| `.array()`                             | Makes the column an array of its element type (Postgres `type[]`)           |
| `.$onUpdate(() => value)`              | Value applied on every `UPDATE` of the row                                  |
| `.named(name)`                         | Overrides the database column name                                          |

> **Nullability:** Sisal columns are **nullable by default**, matching SQL and
> Drizzle. Call `.notNull()` to require a value; `.primaryKey()` implies it. A
> column's inferred value type is therefore `T | null` until you narrow it with
> `.notNull()`/`.primaryKey()`.

### Type inference

```ts
type User = InferSelect<typeof users>; // row shape returned by selects
type NewUser = InferInsert<typeof users>; // accepted insert shape

// `InferInsert` honors `.optional()` and `.default()` to make fields optional.
```

## Typed SQL

### `sql` tagged template

```ts
function sql(strings: TemplateStringsArray, ...values: unknown[]): Sql;
```

Interpolated values become bound **parameters**; nested `Sql` fragments are
inlined. This is the safe building block for everything else.

```ts
const frag = sql`id = ${userId} and active = ${true}`;
```

### Other SQL builders

| Function                                      | Purpose                                                    |
| --------------------------------------------- | ---------------------------------------------------------- |
| `raw(value)`                                  | Unsanitized raw SQL — trusted literals only                |
| `identifier(value)`                           | Validated identifier fragment (dotted paths allowed)       |
| `joinSql(items, separator = raw(", "))`       | Joins `Sql[]` with a separator fragment                    |
| `emptySql()`                                  | Empty fragment                                             |
| `renderSql(sql, { dialect? })`                | Renders a fragment to `{ text, params }`                   |
| `normalizeSqlInput(input, params?, dialect?)` | Normalizes `Sql \| SqlQuery \| string` into a driver query |
| `quoteIdentifier(name, dialect?)`             | Quotes/validates an identifier (`"` or backtick for mysql) |
| `toSql(sqlOrCondition)`                       | Unwraps a `Sql` or `Condition` to `Sql`                    |
| `serializeSqlValue(value)`                    | Coerces a JS value into a `SqlParameter`                   |
| `normalizeTemporalSqlValue(value)`            | Converts Temporal values (including arrays) to ISO strings |
| `isSql(v)` / `isSqlQuery(v)`                  | Type guards                                                |

Rendering is dialect-aware: parameters render as `$1, $2, …` for `postgres` and
`?` otherwise; identifiers are quoted per dialect.

## Predicates / operators

Each returns a `Condition`. Comparison operators bind their right-hand value as
a parameter unless it is itself a column (which renders as a column reference,
for join conditions).

| Operator                         | SQL                                               |
| -------------------------------- | ------------------------------------------------- |
| `eq(col, value)`                 | `col = $n`                                        |
| `ne(col, value)`                 | `col <> $n`                                       |
| `gt` / `gte` / `lt` / `lte`      | `col > / >= / < / <= $n`                          |
| `like(col, value)`               | `col like $n`                                     |
| `ilike(col, value)`              | `col ilike $n` (Postgres-oriented)                |
| `notLike` / `notIlike`           | `col not like / not ilike $n`                     |
| `between(col, min, max)`         | `col between $1 and $2` (inclusive)               |
| `notBetween(col, min, max)`      | `col not between $1 and $2`                       |
| `inArray(col, values \| sub)`    | `col in (...)` / `in (subquery)`; empty → `1 = 0` |
| `notInArray(col, values \| sub)` | `col not in (...)`; empty → `1 = 1`               |
| `isNull(col)` / `isNotNull(col)` | `col is [not] null`                               |
| `exists(sub)` / `notExists(sub)` | `[not] exists (subquery)`                         |
| `arrayContains(col, v)`          | `col @> $n` (Postgres arrays)                     |
| `arrayContained(col, v)`         | `col <@ $n` (Postgres arrays)                     |
| `arrayOverlaps(col, v)`          | `col && $n` (Postgres arrays)                     |
| `and(...conds)`                  | `(...) and (...)`; ignores nullish                |
| `or(...conds)`                   | `(...) or (...)`; ignores nullish                 |
| `not(cond)`                      | `not (...)`                                       |

### Ordering & aggregates

`asc(col)` / `desc(col)` build order terms for `orderBy` (which also accepts the
legacy `(col, "asc" | "desc")` form and multiple terms). The aggregate helpers
`count(col?)`, `countDistinct(col)`, `sum(col)`, `avg(col)`, `min(col)`,
`max(col)` return a typed `SqlExpression<T>` for use in select projections:

```ts
const rows = await db
  .select({ org: users.columns.orgId, total: count() })
  .from(users)
  .orderBy(desc(count()))
  .execute(); // rows: { org: ...; total: number }[]
```

## Database facade & query builders

### `createDatabase(options?)`

```ts
function createDatabase(options?: {
  driver?: OrmDriver;
  dialect?: SqlDialect; // "postgres" | "sqlite" | "mysql" | "generic"
  logger?: Logger;
  schema?: DatabaseSchema;
  relations?: RelationsList;
  temporal?: { parse?: boolean };
}): Database;
```

`Database` methods: `execute`, callable `query`, schema-aware
`query.<table>.findMany/findFirst`, `select`, `$with`/`with` (CTEs),
`$count(table, where?)`, `insert`, `update`, `delete`, `transaction`, and
`close`. Query builders are immutable and lazy — call `.toSql()` to inspect or
`.execute()` to run.

`temporal.parse` defaults to `false`. When set to `true`, ORM-built queries that
carry column metadata (`select` from known tables/projections, `returning()`,
relational queries, and `db.call(defineFunction(...))`) decode known date/time
columns to their declared Temporal/string/Date mode. Raw `db.query(sql\`...\`)`
results do not auto-parse because they have no semantic column metadata.

```ts
const db = createDatabase({ dialect: "postgres", driver });

await db.select().from(users)
  .where(gt(users.columns.age, 18))
  .orderBy(users.columns.createdAt, "desc")
  .limit(20)
  .execute();

await db.insert(users).values({ id, email, name }).returning().execute();

await db.update(users).set({ name }).where(eq(users.columns.id, id)).execute();

await db.delete(users).where(eq(users.columns.id, id)).execute();

await db.transaction(async (tx) => {
  await tx.insert(users).values(row).execute();
});
```

**Builder methods**

- `SelectBuilder`: `from`, `distinct`, `distinctOn(...cols)`, `innerJoin`,
  `leftJoin`, `rightJoin`, `fullJoin`, `where`, `groupBy(...cols)`,
  `having(cond)`, `orderBy` (legacy `(col, "asc" | "desc")` or `asc()`/`desc()`
  terms), `limit`, `offset`, `for(strength, options?)` (row locking),
  `as(alias)` (derived table),
  `union`/`unionAll`/`intersect`/`intersectAll`/`except`/`exceptAll`, `toSql`,
  `execute`.
- `InsertBuilder`: `values`, `onConflictDoNothing({ target? })`,
  `onConflictDoUpdate({ target, set, where? })`, `returning(projection?)`,
  `toSql`, `execute`.
- `UpdateBuilder`: `set`, `where`, `unsafeAllowAllRows`, `returning`, `toSql`,
  `execute`.
- `DeleteBuilder`: `where`, `unsafeAllowAllRows`, `returning`, `toSql`,
  `execute`.

> **Safety rail:** `update`/`delete` without a `where` throw unless you call
> `.unsafeAllowAllRows()` first.

### Relations & relational queries

`relations(table, ({ one, many }) => ({ ... }))` defines typed one-to-one and
one-to-many metadata. Pass a schema map and relation list into
`createDatabase()` to enable `db.query.<tableKey>`:

```ts
const posts = defineTable("posts", {
  id: columns.uuid().primaryKey(),
  userId: columns.uuid().notNull().references("users", "id"),
  title: columns.text().notNull(),
});

const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts, {
    fields: [users.columns.id],
    references: [posts.columns.userId],
  }),
}));

const db = createDatabase({
  dialect: "postgres",
  driver,
  schema: { users, posts },
  relations: [usersRelations],
});

const rows = await db.query.users.findMany({
  columns: { id: true, email: true },
  with: { posts: { columns: { id: true, title: true } } },
  where: gt(users.columns.age, 18),
  orderBy: desc(users.columns.createdAt),
  limit: 20,
});
```

`findMany(config?)` returns an array. `findFirst(config?)` adds `limit 1` and
returns one row or `undefined`. `columns` can include selected columns (`true`)
or exclude columns (`false`); `with` accepts `true` for a relation's default
selection or a nested relational query config.

### CTEs & set operations

Common table expressions are fluent. Create one with `db.$with(name).as(query)`
— its columns are inferred from the inner query's projection — and consume it
via `db.with(cte).select(...).from(cte)`:

```ts
const adults = db.$with("adults").as(
  db.select({ id: users.columns.id, age: users.columns.age })
    .from(users).where(gt(users.columns.age, 18)),
);

await db.with(adults)
  .select({ id: adults.id, n: count() })
  .from(adults)
  .groupBy(adults.id)
  .execute();
// with "adults" as (select … where age > $1) select … from "adults" group by …
```

Set operations chain off any select and return a `CompoundSelectBuilder`;
trailing `orderBy`/`limit`/`offset` apply to the whole compound:

```ts
const a = db.select({ id: users.columns.id }).from(users).where(/* … */);
const b = db.select({ id: users.columns.id }).from(users).where(/* … */);

await a.union(b).orderBy(asc(users.columns.id)).limit(10).execute();
// also: .unionAll, .intersect, .intersectAll, .except, .exceptAll
```

Operands are **not** parenthesized, so the same query renders correctly on both
Postgres and SQLite (which rejects parenthesized compound operands). Recursive
CTEs are written with the `` sql`...` `` template.

### Subqueries, locking & counts

A select aliased with `.as("x")` becomes a **derived table**: pass it to
`.from(...)` and reference its projected columns as `x.col`. The same builder
also embeds as a parenthesized **scalar subquery** inside a projection or a
`where` condition, and as the right side of `inArray(col, subquery)`:

```ts
const recent = db.select({ id: posts.columns.id, userId: posts.columns.userId })
  .from(posts).where(gt(posts.columns.createdAt, cutoff)).as("recent");

await db.select({ id: recent.id }).from(recent).execute();
// select "recent"."id" from (select … from "posts" where …) as "recent"

await db.select({
  name: users.columns.name,
  postCount: db.select({ c: count() }).from(posts)
    .where(eq(posts.columns.userId, users.columns.id)), // scalar subquery
}).from(users).execute();

await db.select().from(users)
  .where(
    inArray(users.columns.id, db.select({ id: recent.userId }).from(recent)),
  )
  .execute();
```

`db.$count(table, where?)` returns a row count as a `number`. `.distinctOn(...)`
emits Postgres `SELECT DISTINCT ON (...)`. `.for("update" | "share", options?)`
appends row-level locking (`{ skipLocked }`, `{ noWait }`, or `{ of }`) on
Postgres/MySQL:

```ts
const n = await db.$count(users, gt(users.columns.age, 18));

await db.select().from(users)
  .for("update", { skipLocked: true }) // for update skip locked
  .limit(1)
  .execute();
```

### Drivers

| Helper                      | Description                                      |
| --------------------------- | ------------------------------------------------ |
| `noopOrmDriver()`           | Returns empty result sets; for tests/scaffolding |
| `memoryOrmDriver(options?)` | Tiny test driver that returns empty rows         |

`OrmDriver` is the async contract adapters implement (`query`, `execute`,
optional `transaction`, `close`). `OrmTransaction` is the in-transaction facade.

## Schema snapshots

A snapshot is a serializable, dialect-neutral description of a schema used by
the migration tooling. Built from tables or authored directly.

| Function                                                | Purpose                                                           |
| ------------------------------------------------------- | ----------------------------------------------------------------- |
| `createSchemaSnapshot({ tables, dialect?, metadata? })` | Build a normalized, validated snapshot from ORM tables            |
| `defineSchemaSnapshot(input)`                           | Normalize + validate a hand-authored snapshot                     |
| `validateSchemaSnapshot(snapshot)`                      | Return `SisalSchemaIssue[]` without throwing                      |
| `assertValidSchemaSnapshot(snapshot)`                   | Throw on the first validation problem                             |
| `normalizeSchemaSnapshot(snapshot)`                     | Deterministic clone (sorted tables/constraints)                   |
| `serializeSchemaSnapshot(snapshot)`                     | Canonical JSON (stable across ordering)                           |
| `deserializeSchemaSnapshot(text)`                       | Parse → normalize → validate                                      |
| `equalSchemaSnapshots(a, b)`                            | Structural equality after normalization                           |
| `diffSchemaSnapshots(from, to)`                         | Structural diff (`addedTables`, `removedTables`, `changedTables`) |
| `isEmptySchemaSnapshotDiff(diff)`                       | True when a diff has no changes                                   |

Key types: `SisalSchemaSnapshot`, `SisalTableSnapshot`, `SisalColumnSnapshot`,
`SisalColumnType`, `SisalColumnDefault`, `SisalPrimaryKeySnapshot`,
`SisalIndexSnapshot`, `SisalUniqueConstraintSnapshot`,
`SisalForeignKeySnapshot`, `SisalCheckConstraintSnapshot`, plus the diff types
`SisalSchemaSnapshotDiff` / `SisalTableDiff` / `SisalColumnDiff`. The constant
`SCHEMA_SNAPSHOT_VERSION` is `1`.

`SisalColumnType.dialectType` and `SisalColumnDefault` with `kind: "expression"`
are trusted schema inputs: DDL generators emit them verbatim. Use them only from
developer-authored schema code, not runtime values.

## Introspection & utilities

`getTableColumns(table)`, `getTableName(table)`, `isTable(v)`, `isColumn(v)`,
`createColumn(name, definition)`, `normalizeTableName(name)`,
`normalizeColumnName(name)`.

## Errors & logging

- `SisalError` (`@sisal/orm/error`) — base structured error with `code`,
  `status`, `expose`, `severity`, `details`.
- `redactSecrets(text)` / `redactErrorCause(cause)` — mask connection-string
  passwords and token-like key/value secrets before logging or wrapping errors.
- `OrmError` — schema/SQL/execution failures; `OrmErrorCode` enumerates causes.
- `Logger` / `LoggerMethod` (`@sisal/orm/logger`) — the minimal logger contract
  accepted everywhere (`debug`/`info`/`warn`/`error`).

---

# @sisal/migrate

Adapter-neutral migration definitions, checksums, planning, drift checks, the
file workflow, and a generic runner. Depends only on `@sisal/orm`.

## Defining migrations

```ts
function defineSqlMigration(opts: {
  id: string;
  up: string;
  down?: string;
  description?: string;
  checksum?: string;
  createdAt?: string;
}): SqlMigration;

function defineMigration(opts: {
  id: string;
  up: MigrationStep; // string | string[] | (ctx) => void | Promise<void>
  down?: MigrationStep;
  /* ...same metadata... */
}): ProgrammaticMigration;
```

A `Migration` is `SqlMigration | ProgrammaticMigration`. `MigrationStep` covers
raw SQL, an array of SQL statements, or a callback receiving a
`MigrationContext` (`driver`, `logger`, `dryRun`, `direction`).

## Running migrations

### `createMigrator(options)`

```ts
function createMigrator(options: {
  migrations: Migration[];
  store?: MigrationStore; // default: memoryMigrationStore()
  driver?: MigrationDriver; // default: noopMigrationDriver()
  logger?: Logger;
  lockId?: string; // default: "sisal:migrate"
  useTransaction?: boolean; // default: true
}): Migrator;
```

`Migrator`: `plan()`, `up(options?)`, `down(options?)`, `pending()`,
`applied()`, `close()`.

```ts
const migrator = createMigrator({ migrations, store, driver });

const plan = await migrator.plan(); // pending / applied / checksumMismatches
await migrator.up({ dryRun: true }); // preview
await migrator.up(); // apply pending (advisory-locked, transactional)
await migrator.down({ steps: 1 }); // roll back the last migration
await migrator.down({ to: "0003_x" }); // roll back down to (and including) an id
```

Run options: `MigrationRunOptions` (`dryRun`, `steps`, `allowDirty`) and
`MigrationDownOptions` (adds `to`). The runner refuses to proceed on a checksum
mismatch unless `allowDirty: true`.

## Stores & drivers

- `memoryMigrationStore(options?)` — in-memory history + lock for tests.
- `noopMigrationDriver()` / `noopMigrator()` — execute nothing.
- `MigrationStore` — async contract: `listApplied`, `getApplied`, `markApplied`,
  `unmarkApplied`, optional `acquireLock`/`releaseLock`/`clear`/`close`.
- `MigrationDriver` — `execute(sql)`, optional `transaction`, `close`.

## Planning & schema diff

| Function                                   | Purpose                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| `createMigrationPlan(migrations, applied)` | Pure plan from known migrations + applied history                      |
| `planSchemaChanges({ from?, to })`         | Classify snapshot diff into ordered `SchemaChange[]`, flag destructive |
| `planSchemaChangesFromDiff(diff)`          | Classify an already-computed schema snapshot diff                      |
| `defineSchemaMigrationPlan({ from?, to })` | Validate/normalize a snapshot pair                                     |

`SchemaChange.kind` is one of `create_table`, `drop_table`, `add_column`,
`drop_column`, `alter_column`; `destructive` is set for drop/alter.

## Checksums & helpers

`calculateMigrationChecksum`, `assertMigrationChecksum`,
`createAppliedMigration`, `isMigrationApplied`, `getPendingMigrations`,
`getAppliedMigrations`, `getRollbackMigrations`, `sortMigrations`,
`validateMigration`, `validateMigrations`,
`formatMigrationFilename(sequence, name, ext = "sql")`, `slugifyMigrationName`.

## File workflow (`@sisal/migrate/workflow`)

A SQL-first workflow with an **injectable filesystem** so writers/readers are
unit-testable.

| Symbol                                                         | Purpose                                                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `MigrationFileSystem`                                          | Interface: `readDir`, `readFile`, `writeFile`, `mkdir`                                                              |
| `GeneratedMigrationFile` / `DiscoveredMigration`               | File shapes written and read by the workflow                                                                        |
| `denoMigrationFileSystem()`                                    | Deno-backed implementation (needs `--allow-read/-write`)                                                            |
| `buildMigrationFile({ sequence, name, statements, snapshot })` | Pure: build `.sql` + `.snapshot.json` contents                                                                      |
| `writeMigrationFile(fs, dir, file)`                            | Write the generated pair                                                                                            |
| `readMigrationsDir(fs, dir)`                                   | Read + order discovered migrations (with snapshots)                                                                 |
| `parseMigrationSequence(id)` / `nextMigrationSequence(list)`   | Sequence helpers                                                                                                    |
| `defineConfig(config)`                                         | Validate `MigrateConfig` (`dir`, `dialect?`, `snapshot?`, `databaseUrl?`, `databaseAuthToken?`, `databasePath?`, …) |
| `checkDrift(input)`                                            | Pure drift check → `DriftReport`                                                                                    |

`checkDrift` reports `schema_changed` (live schema differs from the newest
captured snapshot), `pending_migrations`, and `missing_snapshot`. Related types:
`MigrateConfig`, `DriftKind`, `DriftFinding`, `DriftReport`, and
`DriftCheckInput`.

## CLI (`@sisal/migrate/cli`)

`runSisalCli(args, options?)` powers the `sisal` executable and returns an exit
code. The real CLI loads `sisal.migrate.ts` by default; tests can inject
`config`, `fs`, dialect `adapters`, `cwd`, `stdout`, and `stderr` through
`SisalCliOptions`.

Commands:

| Command          | Purpose                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------ |
| `sisal init`     | Scaffold `sisal.migrate.ts` + migrations dir (`--force`, `--target`, `--dialect`, `--dir`) |
| `sisal generate` | Diff latest snapshot → `config.snapshot`, write SQL + snapshot                             |
| `sisal migrate`  | Apply pending SQL migrations through the dialect migrator                                  |
| `sisal status`   | Print file counts, database plan, and drift findings                                       |
| `sisal drift`    | Exit non-zero when drift findings exist                                                    |

Config modules should export `default` or `config`:

```ts
import { defineConfig } from "@sisal/migrate";

export default defineConfig({
  dir: "migrations",
  dialect: "sqlite",
  databasePath: "./dev.db",
  snapshot,
});
```

For Turso/libSQL migrations, keep `dialect: "sqlite"` and set `databaseUrl` plus
`databaseAuthToken` (or use `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`).

`generate` emits only non-destructive SQL. Drop/alter changes are reported and
withheld so the captured snapshot cannot get ahead of the SQL that was written.
`splitSqlStatements(text)` is exported from `@sisal/migrate/cli` for tests and
tooling that need the CLI's simple SQL-statement splitting behavior.

## Errors

`MigrationError` with `MigrationErrorCode` (`MIGRATION_INVALID`,
`MIGRATION_DUPLICATE_ID`, `MIGRATION_CHECKSUM_MISMATCH`,
`MIGRATION_LOCK_FAILED`, …).

---

# @sisal/pg

PostgreSQL adapter. Root export bundles the common helpers; `@sisal/pg/orm`,
`@sisal/pg/migrate`, and `@sisal/pg/ddl` are narrower boundaries.

## ORM execution (`@sisal/pg/orm`)

| Symbol                       | Purpose                                              |
| ---------------------------- | ---------------------------------------------------- |
| `createPgDb(options)`        | Open a `PgDatabase` (a `Database` wired to Postgres) |
| `connect(options)`           | Alias for `createPgDb`                               |
| `createPgOrmDriver(options)` | Build the `OrmDriver` only                           |
| `createPgExecutor(options)`  | Lower-level SQL executor                             |
| `createPgPool(options)`      | Connection pool                                      |
| `POSTGRES_DIALECT`           | `"postgres"`                                         |

Types: `PgDatabase`, `CreatePgDbOptions`, `PgOrmDriverOptions`, `PgClient`,
`PgConnectionOptions`, `PgPool`, `PgQueryResult`, `PgSqlExecutor`.

```ts
import { connect } from "@sisal/pg";

const db = await connect({/* connection options */});
await db.select().from(users).execute();
```

## Migrations (`@sisal/pg/migrate`)

`createPgMigrator(options)` returns a `PgMigrator`
(`migrate`/`rollback`/`plan`/`applied`/`close`) backed by an advisory-locked,
database history store.

| Symbol                                   | Purpose                                  |
| ---------------------------------------- | ---------------------------------------- |
| `createPgMigrator(options)`              | Adapter facade over core migration flow  |
| `createPgMigrationDriver(options)`       | `MigrationDriver` backed by Postgres SQL |
| `createPgMigrationHistoryStore(options)` | Database-backed migration history store  |
| `createPgExecutor(options)`              | Lower-level SQL executor                 |
| `createPgPool(options)`                  | Connection pool                          |
| `DEFAULT_PG_MIGRATION_TABLE`             | `"sisal_migrations"`                     |

Types include `CreatePgMigratorOptions`, `PgMigrationDefinition`,
`PgMigrationInput`, `PgMigrateOptions`, `PgRollbackOptions`,
`PgMigrationPlanOptions`, and `PgMigrator`.

## DDL generation (`@sisal/pg/ddl`)

Pure functions — emit SQL strings, never open a connection.

| Function                                        | Output                            |
| ----------------------------------------------- | --------------------------------- |
| `generatePostgresUpStatements(to, from?)`       | `{ statements, destructive }`     |
| `generatePostgresCreateTable(table)`            | `CREATE TABLE …`                  |
| `generatePostgresAddColumn(table, column)`      | `ALTER TABLE … ADD COLUMN …`      |
| `generatePostgresColumnDefinition(column)`      | one column definition             |
| `generatePostgresColumnType(type)`              | a Postgres type expression        |
| `generatePostgresIndexes(table)`                | `CREATE [UNIQUE] INDEX …`         |
| `generatePostgresForeignKeys(table)`            | `ALTER TABLE … ADD FOREIGN KEY …` |
| `quotePgIdent(name)` / `pgQualifiedName(table)` | identifier quoting                |

Only **additive** changes are emitted; destructive changes (drop table/column,
type change) are returned in `destructive` for explicit handling.

```ts
import { columns, createSchemaSnapshot, defineTable } from "@sisal/orm";
import { generatePostgresUpStatements } from "@sisal/pg/ddl";

const users = defineTable("users", {
  id: columns.uuid().primaryKey(),
  email: columns.text().notNull().unique(),
});
const snapshot = createSchemaSnapshot({ dialect: "postgres", tables: [users] });
const { statements } = generatePostgresUpStatements(snapshot);
```

---

# @sisal/neon

Neon serverless PostgreSQL adapter, structured like `@sisal/pg` but backed by
`jsr:@neon/serverless`. It uses the PostgreSQL SQL dialect, migrations, and DDL.

## ORM execution (`@sisal/neon/orm`)

`createNeonDb(options)` / `connect(options)` open a `NeonDatabase`. Options
accept a Neon `url`/`connectionString`, an already-open `pool`/`client`, or an
existing `executor`. Also: `createNeonPool`, `createNeonClient`,
`createNeonExecutor`, `neonPoolConfigFromOptions`,
`neonClientConfigFromOptions`, `resolveNeonConnectionString`,
`normalizeNeonResult`, `NeonError`, `POSTGRES_DIALECT`.

Types: `NeonDatabase`, `CreateNeonDbOptions`, `NeonClient`, `NeonPool`,
`NeonPoolConfig`, `NeonClientConfig`, `NeonPoolConnectionOptions`,
`NeonClientConnectionOptions`, `NeonExecutorOptions`, `NeonSqlExecutor`,
`NeonSqlResult`, `NeonQueryResult`, `NeonDriverQueryResult`, and
`NeonErrorCode`.

```ts
import { connect } from "@sisal/neon";

const db = await connect({
  url: Deno.env.get("DATABASE_URL"),
});
```

## Migrations (`@sisal/neon/migrate`)

`createNeonMigrator(options)` -> `NeonMigrator`, backed by the PostgreSQL
migrator and history table. Also: `DEFAULT_NEON_MIGRATION_TABLE`. The migrate
subpath also re-exports the Neon client/executor helpers so migration-only code
can build pools, clients, or executors without importing `@sisal/neon/orm`.

## DDL generation (`@sisal/neon/ddl`)

Neon uses PostgreSQL syntax, so this subpath re-exports the `@sisal/pg/ddl`
helpers: `generatePostgresUpStatements`, `generatePostgresCreateTable`,
`generatePostgresAddColumn`, `generatePostgresColumnDefinition`,
`generatePostgresColumnType`, `quotePgIdent`, and `pgQualifiedName`.

---

# @sisal/sqlite

SQLite adapter, structured exactly like `@sisal/pg`.

## ORM execution (`@sisal/sqlite/orm`)

`createSqliteDb(options?)` / `connect(options?)` open a `SqliteDatabase`
(`@db/sqlite` is opened lazily, only when neither an `executor` nor an existing
`database` is injected — so DDL/tests stay permission-free). Also:
`createSqliteOrmDriver`, `createSqliteExecutor`, `openSqliteDatabase`,
`statementReturnsRows`, `sqliteColumnAffinity`, `SQLITE_DIALECT`.

Types: `SqliteDatabase`, `CreateSqliteDbOptions`, `SqliteConnectionOptions`,
`SqliteLikeDatabase`, `SqliteStatement`, `SqliteOrmDriverOptions`,
`SqliteExecutorOptions`, `SqliteQueryResult`, `SqliteSqlExecutor`.

## Migrations (`@sisal/sqlite/migrate`)

`createSqliteMigrator(options)` → `SqliteMigrator`. Also
`createSqliteMigrationDriver`, `createSqliteMigrationHistoryStore`,
`createSqliteExecutor`, `openSqliteDatabase`, `statementReturnsRows`,
`DEFAULT_SQLITE_MIGRATION_TABLE`, and the SQLite connection/database/executor
types.

## DDL generation (`@sisal/sqlite/ddl`)

`generateSqliteUpStatements(to, from?)`, `generateSqliteCreateTable`,
`generateSqliteAddColumn`, `generateSqliteColumnDefinition`,
`generateSqliteColumnType`, `generateSqliteIndexes`, `quoteSqliteIdent`.
Higher-level types collapse onto SQLite's five affinities
(`TEXT`/`INTEGER`/`REAL`/`NUMERIC`/`BLOB`); booleans → `INTEGER`,
dates/JSON/UUID → `TEXT`. Because SQLite has limited `ALTER TABLE`, destructive
changes are always withheld and returned in `destructive`.

```ts
import { generateSqliteUpStatements } from "@sisal/sqlite/ddl";

const { statements } = generateSqliteUpStatements(snapshot);
```

---

# @sisal/libsql

libSQL/Turso adapter, structured like `@sisal/sqlite` but backed by
`@libsql/client`. It uses the SQLite SQL dialect for rendering and DDL.

## ORM execution (`@sisal/libsql/orm`)

`createLibsqlDb(options)` / `connect(options)` open a `LibsqlDatabase`. Options
accept a Turso/libSQL `url`, optional `authToken`, or an already-open `client`.
Also: `createLibsqlOrmDriver`, `createLibsqlExecutor`, `openLibsqlClient`,
`createLibsqlClient`, `isLibsqlUrl`, `libsqlConfigFromOptions`,
`LIBSQL_DIALECT`.

Types: `LibsqlDatabase`, `CreateLibsqlDbOptions`, `LibsqlConnectionOptions`,
`LibsqlClient`, `LibsqlClientConfig`, `LibsqlArgs`, `LibsqlValue`,
`LibsqlInValue`, `LibsqlStatement`, `LibsqlResultSet`, `LibsqlTransaction`,
`LibsqlOrmDriverOptions`, `LibsqlExecutorOptions`, `LibsqlQueryResult`, and
`LibsqlSqlExecutor`.

```ts
import { connect } from "@sisal/libsql";

const db = await connect({
  url: Deno.env.get("TURSO_DATABASE_URL")!,
  authToken: Deno.env.get("TURSO_AUTH_TOKEN"),
});
```

## Migrations (`@sisal/libsql/migrate`)

`createLibsqlMigrator(options)` -> `LibsqlMigrator`. Also
`createLibsqlMigrationDriver`, `createLibsqlMigrationHistoryStore`,
`createLibsqlExecutor`, `openLibsqlClient`, `createLibsqlClient`, `isLibsqlUrl`,
`libsqlConfigFromOptions`, `DEFAULT_LIBSQL_MIGRATION_TABLE`, and the libSQL
client/executor/migration types.

## DDL generation (`@sisal/libsql/ddl`)

libSQL uses SQLite syntax, so DDL helpers are SQLite-compatible aliases:
`generateLibsqlUpStatements(to, from?)`, `generateLibsqlCreateTable`,
`generateLibsqlAddColumn`, `generateLibsqlColumnDefinition`,
`generateLibsqlColumnType`, `quoteLibsqlIdent`.
