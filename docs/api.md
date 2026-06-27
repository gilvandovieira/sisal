---
title: API Reference
---

# Sisal API Reference

Complete reference for the public API of every Sisal package, generated from a
full read of the source. Sisal is a Deno-first, JSR-native database toolkit made
of four packages with strict boundaries:

| Package          | Import root      | Responsibility                                          |
| ---------------- | ---------------- | ------------------------------------------------------- |
| `@sisal/orm`     | `@sisal/orm`     | Driverless schema, typed SQL, query builders, snapshots |
| `@sisal/migrate` | `@sisal/migrate` | Adapter-neutral migration planning, running, workflow   |
| `@sisal/pg`      | `@sisal/pg`      | PostgreSQL execution, history, migrator, DDL            |
| `@sisal/sqlite`  | `@sisal/sqlite`  | SQLite execution, history, migrator, DDL                |

The ORM never imports an adapter; adapters depend on `@sisal/orm`. See
[`drizzle-parity.md`](./drizzle-parity.md) for how this surface maps to Drizzle
ORM 0.45.2 and where it diverges on purpose.

> **Stability:** all packages are `0.1.0` (pre-1.0). The surface below is
> current but may change before 1.0.

---

## Subpath exports

Each package exposes narrower entry points so an app can import the smallest
boundary it needs.

```text
@sisal/orm            @sisal/migrate          @sisal/pg               @sisal/sqlite
  .   -> mod.ts         .        -> mod.ts       .       -> mod.ts       .       -> mod.ts
  ./core                ./cli                    ./orm                   ./orm
  ./error               ./core                   ./migrate               ./migrate
  ./logger                                       ./ddl                   ./ddl
  ./schema              ./workflow
```

---

# @sisal/orm

Driverless. Owns schema definitions, typed SQL fragments, predicates, query
builders, the database facade, and serializable schema snapshots.

## Schema definition

### `defineTable(name, columns, options?)`

```ts
function defineTable<TColumns extends TableColumns>(
  name: string,
  columns: TColumns,
  options?: { schema?: string },
): TableDefinition<TColumns>;
```

Defines a typed, frozen table. Column DB names default to the property key (or
`.named(...)` override). Returns a `TableDefinition` whose `.columns[key]`
entries carry `name`, `tableName`, `propertyName`, and the resolved flags.

```ts
import { columns, defineTable } from "@sisal/orm";

const users = defineTable("users", {
  id: columns.uuid().primaryKey(),
  email: columns.text().notNull().unique(),
  name: columns.text().notNull(),
  age: columns.integer().optional(),
  createdAt: columns.timestamp({ withTimezone: true }).default(() =>
    new Date()
  ),
  orgId: columns.uuid().references("organizations", "id"),
});

// Column references are reached through `.columns`:
users.columns.id; // { name: "id", tableName: "users", dataType: "uuid", ... }
```

### `columns` — column builder factory

`columns` is a frozen object of constructors. Each returns an immutable
`ColumnBuilder`.

| Factory                               | Value type | Notes                                     |
| ------------------------------------- | ---------- | ----------------------------------------- |
| `columns.text()`                      | `string`   |                                           |
| `columns.varchar(length?)`            | `string`   | `varchar(n)` when `length` given          |
| `columns.char(length?)`               | `string`   | `char(n)` when `length` given             |
| `columns.integer()`                   | `number`   |                                           |
| `columns.smallint()`                  | `number`   |                                           |
| `columns.bigint()`                    | `string`   | string-typed to preserve 64-bit precision |
| `columns.serial()`                    | `number`   | auto-increment; optional on insert        |
| `columns.bigserial()`                 | `string`   | auto-increment; optional on insert        |
| `columns.numeric(precision?, scale?)` | `string`   | string-typed to preserve precision        |
| `columns.decimal(precision?, scale?)` | `string`   | alias of `numeric`                        |
| `columns.real()`                      | `number`   |                                           |
| `columns.doublePrecision()`           | `number`   | Postgres `double precision`               |
| `columns.number()`                    | `number`   | generic numeric                           |
| `columns.boolean()`                   | `boolean`  |                                           |
| `columns.json<T>()`                   | `T`        | defaults `T = Record<string, unknown>`    |
| `columns.jsonb<T>()`                  | `T`        | Postgres `jsonb`                          |
| `columns.date()`                      | `Date`     |                                           |
| `columns.timestamp(options?)`         | `Date`     | `{ withTimezone: true }` → `timestamptz`  |
| `columns.uuid()`                      | `string`   |                                           |

### Column modifiers (`ColumnBuilder`)

All modifiers return a **new** builder (immutable chaining).

| Modifier                         | Effect                                                               |
| -------------------------------- | -------------------------------------------------------------------- |
| `.notNull()`                     | Requires a value (opt out of the nullable default)                   |
| `.nullable()`                    | Marks the column nullable (the default; explicit for readability)    |
| `.optional()`                    | Makes the field optional **on insert** (does not change nullability) |
| `.default(value \| () => value)` | Sets a default; also makes the field optional on insert              |
| `.primaryKey()`                  | Adds the column to the primary key (implies `.notNull()`)            |
| `.unique()`                      | Adds a single-column unique constraint                               |
| `.references(table, column)`     | Adds a single-column foreign key                                     |
| `.array()`                       | Makes the column an array of its element type (Postgres `type[]`)    |
| `.$onUpdate(() => value)`        | Value applied on every `UPDATE` of the row                           |
| `.named(name)`                   | Overrides the database column name                                   |

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
| `isSql(v)` / `isSqlQuery(v)`                  | Type guards                                                |

Rendering is dialect-aware: parameters render as `$1, $2, …` for `postgres` and
`?` otherwise; identifiers are quoted per dialect.

## Predicates / operators

Each returns a `Condition`. Comparison operators bind their right-hand value as
a parameter unless it is itself a column (which renders as a column reference,
for join conditions).

| Operator                         | SQL                                 |
| -------------------------------- | ----------------------------------- |
| `eq(col, value)`                 | `col = $n`                          |
| `ne(col, value)`                 | `col <> $n`                         |
| `gt` / `gte` / `lt` / `lte`      | `col > / >= / < / <= $n`            |
| `like(col, value)`               | `col like $n`                       |
| `ilike(col, value)`              | `col ilike $n` (Postgres-oriented)  |
| `notLike` / `notIlike`           | `col not like / not ilike $n`       |
| `between(col, min, max)`         | `col between $1 and $2` (inclusive) |
| `notBetween(col, min, max)`      | `col not between $1 and $2`         |
| `inArray(col, values)`           | `col in (...)`; empty → `1 = 0`     |
| `notInArray(col, values)`        | `col not in (...)`; empty → `1 = 1` |
| `isNull(col)` / `isNotNull(col)` | `col is [not] null`                 |
| `and(...conds)`                  | `(...) and (...)`; ignores nullish  |
| `or(...conds)`                   | `(...) or (...)`; ignores nullish   |
| `not(cond)`                      | `not (...)`                         |

### Ordering & aggregates

`asc(col)` / `desc(col)` build order terms for `orderBy` (which also accepts the
legacy `(col, "asc" | "desc")` form and multiple terms). The aggregate helpers
`count(col?)`, `sum(col)`, `avg(col)`, `min(col)`, `max(col)` return a typed
`SqlExpression<T>` for use in select projections:

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
}): Database;
```

`Database` methods: `execute`, `query`, `select`, `insert`, `update`, `delete`,
`transaction`, `close`. Query builders are immutable and lazy — call `.toSql()`
to inspect or `.execute()` to run.

```ts
const db = createDatabase({ dialect: "postgres", driver });

await db.select().from(users)
  .where(and(eq(users.columns.active, true), gt(users.columns.age, 18)))
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

- `SelectBuilder`: `from`, `distinct`, `innerJoin`, `leftJoin`, `rightJoin`,
  `fullJoin`, `where`, `groupBy(...cols)`, `having(cond)`, `orderBy` (legacy
  `(col, "asc" | "desc")` or `asc()`/`desc()` terms), `limit`, `offset`,
  `toSql`, `execute`.
- `InsertBuilder`: `values`, `onConflictDoNothing({ target? })`,
  `onConflictDoUpdate({ target, set, where? })`, `returning(projection?)`,
  `toSql`, `execute`.
- `UpdateBuilder`: `set`, `where`, `unsafeAllowAllRows`, `returning`, `toSql`,
  `execute`.
- `DeleteBuilder`: `where`, `unsafeAllowAllRows`, `returning`, `toSql`,
  `execute`.

> **Safety rail:** `update`/`delete` without a `where` throw unless you call
> `.unsafeAllowAllRows()` first.

### Drivers

| Helper                      | Description                                      |
| --------------------------- | ------------------------------------------------ |
| `noopOrmDriver()`           | Returns empty result sets; for tests/scaffolding |
| `memoryOrmDriver(options?)` | Records queries in memory, returns empty rows    |

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

## Introspection & utilities

`getTableColumns(table)`, `getTableName(table)`, `isTable(v)`, `isColumn(v)`,
`createColumn(name, definition)`, `normalizeTableName(name)`,
`normalizeColumnName(name)`.

## Errors & logging

- `SisalError` (`@sisal/orm/error`) — base structured error with `code`,
  `status`, `expose`, `severity`, `details`.
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
| `defineSchemaMigrationPlan({ from?, to })` | Validate/normalize a snapshot pair                                     |

`SchemaChange.kind` is one of `create_table`, `drop_table`, `add_column`,
`drop_column`, `alter_column`; `destructive` is set for drop/alter.

## Checksums & helpers

`calculateMigrationChecksum`, `assertMigrationChecksum`, `getMigrationChecksum`
(internal default), `createAppliedMigration`, `isMigrationApplied`,
`getPendingMigrations`, `getAppliedMigrations`, `getRollbackMigrations`,
`sortMigrations`, `validateMigration`, `validateMigrations`,
`formatMigrationFilename(sequence, name, ext = "sql")`, `slugifyMigrationName`.

## File workflow (`@sisal/migrate/workflow`)

A SQL-first workflow with an **injectable filesystem** so writers/readers are
unit-testable.

| Symbol                                                         | Purpose                                                                                       |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `MigrationFileSystem`                                          | Interface: `readDir`, `readFile`, `writeFile`, `mkdir`                                        |
| `denoMigrationFileSystem()`                                    | Deno-backed implementation (needs `--allow-read/-write`)                                      |
| `buildMigrationFile({ sequence, name, statements, snapshot })` | Pure: build `.sql` + `.snapshot.json` contents                                                |
| `writeMigrationFile(fs, dir, file)`                            | Write the generated pair                                                                      |
| `readMigrationsDir(fs, dir)`                                   | Read + order discovered migrations (with snapshots)                                           |
| `parseMigrationSequence(id)` / `nextMigrationSequence(list)`   | Sequence helpers                                                                              |
| `defineConfig(config)`                                         | Validate `MigrateConfig` (`dir`, `dialect?`, `snapshot?`, `databaseUrl?`, `databasePath?`, …) |
| `checkDrift(input)`                                            | Pure drift check → `DriftReport`                                                              |

`checkDrift` reports `schema_changed` (live schema differs from the newest
captured snapshot), `pending_migrations`, and `missing_snapshot`.

## CLI (`@sisal/migrate/cli`)

`runSisalCli(args, options?)` powers the `sisal` executable and returns an exit
code. The real CLI loads `sisal.migrate.ts` by default; tests can inject
`config`, `fs`, and dialect `adapters`.

Commands:

| Command          | Purpose                                                                        |
| ---------------- | ------------------------------------------------------------------------------ |
| `sisal init`     | Scaffold `sisal.migrate.ts` + migrations dir (`--force`, `--dialect`, `--dir`) |
| `sisal generate` | Diff latest snapshot → `config.snapshot`, write SQL + snapshot                 |
| `sisal migrate`  | Apply pending SQL migrations through the dialect migrator                      |
| `sisal status`   | Print file counts, database plan, and drift findings                           |
| `sisal drift`    | Exit non-zero when drift findings exist                                        |

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

`generate` emits only non-destructive SQL. Drop/alter changes are reported and
withheld so the captured snapshot cannot get ahead of the SQL that was written.

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
database history store. Also: `createPgMigrationDriver`,
`createPgMigrationHistoryStore`, `DEFAULT_PG_MIGRATION_TABLE`. Convenience input
type `PgMigrationDefinition` infers the programmatic/SQL kind for you.

## DDL generation (`@sisal/pg/ddl`)

Pure functions — emit SQL strings, never open a connection.

| Function                                        | Output                        |
| ----------------------------------------------- | ----------------------------- |
| `generatePostgresUpStatements(to, from?)`       | `{ statements, destructive }` |
| `generatePostgresCreateTable(table)`            | `CREATE TABLE …`              |
| `generatePostgresAddColumn(table, column)`      | `ALTER TABLE … ADD COLUMN …`  |
| `generatePostgresColumnDefinition(column)`      | one column definition         |
| `generatePostgresColumnType(type)`              | a Postgres type expression    |
| `quotePgIdent(name)` / `pgQualifiedName(table)` | identifier quoting            |

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
`DEFAULT_SQLITE_MIGRATION_TABLE`.

## DDL generation (`@sisal/sqlite/ddl`)

`generateSqliteUpStatements(to, from?)`, `generateSqliteCreateTable`,
`generateSqliteAddColumn`, `generateSqliteColumnDefinition`,
`generateSqliteColumnType`, `quoteSqliteIdent`. Higher-level types collapse onto
SQLite's five affinities (`TEXT`/`INTEGER`/`REAL`/`NUMERIC`/`BLOB`); booleans →
`INTEGER`, dates/JSON/UUID → `TEXT`. Because SQLite has limited `ALTER TABLE`,
destructive changes are always withheld and returned in `destructive`.

```ts
import { generateSqliteUpStatements } from "@sisal/sqlite/ddl";

const { statements } = generateSqliteUpStatements(snapshot);
```
