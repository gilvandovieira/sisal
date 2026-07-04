---
title: API Reference
---

# Sisal API Reference

This reference is verified against the current workspace package exports and
source layout. Sisal is a Deno-first database toolkit, published to JSR, with a
driverless core, a driverless ORM facade, adapter-neutral migration tooling, and
explicit database adapters.

| Package            | Import root        | Responsibility                                     |
| ------------------ | ------------------ | -------------------------------------------------- |
| `@sisal/core`      | `@sisal/core`      | Schema primitives, SQL IR, operators, capabilities |
| `@sisal/orm`       | `@sisal/orm`       | Database facade, fluent builders, relations, calls |
| `@sisal/migrate`   | `@sisal/migrate`   | Migration definitions, planning, workflow, CLI     |
| `@sisal/etl`       | `@sisal/etl`       | Rollup jobs, window math, runner APIs, status      |
| `@sisal/analytics` | `@sisal/analytics` | Analytical dimensions, metrics, windows, execution |
| `@sisal/pg`        | `@sisal/pg`        | PostgreSQL ORM, migration adapter, DDL             |
| `@sisal/neon`      | `@sisal/neon`      | Neon serverless PostgreSQL ORM/migrations          |
| `@sisal/sqlite`    | `@sisal/sqlite`    | SQLite ORM, migration adapter, DDL                 |
| `@sisal/libsql`    | `@sisal/libsql`    | libSQL/Turso ORM, migration adapter, SQLite DDL    |
| `@sisal/mysql`     | `@sisal/mysql`     | MySQL/MariaDB ORM, migration adapter, DDL          |

The manifests in this workspace are currently `0.11.0`; this page reflects the
current tree, including the ETL and analytics preview packages plus API
additions such as structured logging controls and `await using` disposal
aliases.

## Subpath Exports

Each package exposes smaller import boundaries:

| Package            | Subpaths                                         |
| ------------------ | ------------------------------------------------ |
| `@sisal/core`      | `.`, `./schema`, `./unstable-internal`           |
| `@sisal/orm`       | `.`, `./core`, `./schema`, `./error`, `./logger` |
| `@sisal/migrate`   | `.`, `./core`, `./workflow`, `./cli`             |
| `@sisal/etl`       | `.`                                              |
| `@sisal/analytics` | `.`                                              |
| `@sisal/pg`        | `.`, `./orm`, `./migrate`, `./ddl`               |
| `@sisal/neon`      | `.`, `./orm`, `./migrate`, `./ddl`               |
| `@sisal/sqlite`    | `.`, `./orm`, `./migrate`, `./ddl`               |
| `@sisal/libsql`    | `.`, `./orm`, `./migrate`, `./ddl`               |
| `@sisal/mysql`     | `.`, `./orm`, `./migrate`, `./ddl`               |

`@sisal/core/unstable-internal` is exported for Sisal packages. Application code
should treat it as internal plumbing.

---

# `@sisal/core`

`@sisal/core` is the driverless compile target: table/column metadata,
serializable schema snapshots, the SQL fragment IR, expression helpers, dialect
capability declarations, structured errors, and logging contracts. `@sisal/orm`
re-exports the stable core surface for compatibility.

## Tables And Columns

### `defineTable(name, columns, extrasOrOptions?, options?)`

Defines a frozen typed table. Column DB names default to the table's naming
strategy, whose global default is `"snake_case"` (`createdAt` -> `created_at`).
Use `.named(...)` for an explicit physical column name, or pass
`{ naming: "preserve" | "camelCase" | "snake_case" | fn }` per table.

```ts
import { check, columns, defineTable, desc, index, sql } from "@sisal/core";

const posts = defineTable(
  "posts",
  {
    id: columns.uuid().primaryKey(),
    title: columns.text().notNull(),
    body: columns.text(),
    score: columns.integer().notNull().default(0),
    createdAt: columns.timestamp({ withTimezone: true }).notNull(),
    search: columns.customType<string>({
      kind: "tsvector",
      dialectType: "tsvector",
    }).generatedAs(sql`to_tsvector('simple', title)`, { stored: true }),
  },
  (t) => [
    index("posts_feed_idx")
      .where(sql`${t.score} > 0`)
      .on(desc(t.score), desc(t.createdAt), t.id),
    check("posts_score_check", sql`${t.score} >= ${0}`),
  ],
);
```

Table-level helpers:

| Helper                         | Purpose                                      |
| ------------------------------ | -------------------------------------------- |
| `index(name?).where(sql).on()` | Non-unique index; supports partial indexes   |
| `uniqueIndex(name?).on(...)`   | Unique index                                 |
| `primaryKey({ columns })`      | Composite/table-level primary key            |
| `unique(name?).on(...cols)`    | Composite/table-level unique constraint      |
| `check(name, sql)`             | Named check constraint from trusted SQL text |

Index keys accept column refs, physical column names, `asc()`/`desc()` terms,
and `sql` expressions. Expression indexes, partial-index predicates, check
expressions, generated-column expressions, custom `dialectType`, and SQL
defaults are trusted schema inputs emitted into DDL verbatim.

### `columns`

`columns` is a frozen factory of immutable `ColumnBuilder`s:

| Factory                               | Value type               | Notes                                      |
| ------------------------------------- | ------------------------ | ------------------------------------------ |
| `text()` / `varchar(n?)` / `char(n?)` | `string`                 | Text-like columns                          |
| `integer()` / `smallint()`            | `number`                 | Integer columns                            |
| `bigint()`                            | `string`                 | Preserves 64-bit precision                 |
| `serial()` / `bigserial()`            | `number` / `string`      | Auto-increment, insert-optional            |
| `numeric(p?, s?)` / `decimal(p?, s?)` | `string`                 | Preserves decimal precision                |
| `real()` / `doublePrecision()`        | `number`                 | Floating-point columns                     |
| `number()`                            | `number`                 | Generic numeric                            |
| `boolean()`                           | `boolean`                | Boolean column                             |
| `json<T>()` / `jsonb<T>()`            | `T`                      | `jsonb` is PostgreSQL-oriented             |
| `date(options?)`                      | `Temporal.PlainDate`     | `mode: "date"` -> `Date`, `"string"`       |
| `time(options?)`                      | `Temporal.PlainTime`     | `mode: "string"` available                 |
| `timestamp(options?)`                 | `Temporal.PlainDateTime` | `withTimezone: true` -> `Temporal.Instant` |
| `uuid()`                              | `string`                 | UUID text value                            |
| `bytea()`                             | `Uint8Array`             | SQLite/libSQL map this to `BLOB`           |
| `customType<T>(options)`              | `T`                      | Trusted dialect type escape hatch          |

Columns are nullable by default. `InferSelect` reads `T | null` until a column
is narrowed by `.notNull()` or `.primaryKey()`.

Column modifiers:

| Modifier                         | Effect                                             |
| -------------------------------- | -------------------------------------------------- |
| `.named(name)`                   | Override the physical column name                  |
| `.notNull()` / `.nullable()`     | Set read nullability                               |
| `.optional()`                    | Omit key on insert without changing nullability    |
| `.default(value                  | fn                                                 |
| `.primaryKey()`                  | Primary key; implies `.notNull()`                  |
| `.unique()`                      | Single-column unique constraint                    |
| `.references(table, col, opts?)` | Single-column foreign key                          |
| `.array()`                       | Array column; native on PostgreSQL, JSON elsewhere |
| `.generatedAs(sql, { stored? })` | Generated column; trusted expression               |
| `.$onUpdate(fn)`                 | Value applied on every ORM `UPDATE`                |

Type helpers include `InferSelect`, `InferInsert`, `TableDefinition`,
`TableColumn`, `ColumnBuilder`, `ColumnDefinition`, `ColumnDataType`,
`ColumnValueMode`, `DateColumnMode`, `TimeColumnMode`, `TimestampColumnMode`,
`ColumnNamingStrategy`, `getDefaultColumnNaming`, and `setDefaultColumnNaming`.

## SQL Fragments

`sql` is the safe tagged template. Values are bound as parameters, nested `Sql`
fragments are inlined, and table/column refs render as identifiers.

| Helper                                  | Purpose                                      |
| --------------------------------------- | -------------------------------------------- |
| `sql\`...\``                            | Build a parameterized fragment               |
| `raw(text)`                             | Trusted raw SQL literal                      |
| `identifier(name)`                      | Validated quoted identifier path             |
| `placeholder(name)`                     | Named placeholder for prepared builders      |
| `joinSql(items, sep?)` / `emptySql()`   | Fragment composition                         |
| `expr<T>(sql)`                          | Type a fragment as `SqlExpression<T>`        |
| `dialectSql(construct, variants, fb?)`  | Per-dialect rendering branch                 |
| `dialectGuard(construct, unsupported)`  | Render-time unsupported-dialect guard        |
| `renderSql(sql, { dialect, variant })`  | Driver-ready `{ text, params }`              |
| `normalizeSqlInput(input, params?, d?)` | Normalize `Sql`, `SqlQuery`, or string input |
| `quoteIdentifier(name, dialect?)`       | Quote one identifier                         |
| `toSql(value)`                          | Unwrap `Sql` or `Condition`                  |
| `serializeSqlValue(value)`              | Normalize a bind value                       |
| `normalizeTemporalSqlValue(value)`      | ISO-serialize Temporal values recursively    |
| `withSqlChunkMeta` / `sqlChunkMeta`     | Attach/read opaque chunk annotations         |
| `isSql` / `isSqlQuery` / `isColumn`     | Type guards                                  |

Rendering uses `$1`, `$2`, ... for PostgreSQL and `?` for SQLite/libSQL/MySQL.
`SQL_IR_VERSION` is `1`; `SQL_DIALECTS` is
`["postgres", "sqlite", "mysql", "generic"]`.

## Operators And Expressions

Predicates return `Condition`; expressions return typed `SqlExpression<T>`.

| Helper                                                          | Purpose                                |
| --------------------------------------------------------------- | -------------------------------------- |
| `eq`, `ne`, `gt`, `gte`, `lt`, `lte`                            | Comparisons                            |
| `like`, `ilike`, `notLike`, `notIlike`                          | Pattern matching                       |
| `between`, `notBetween`                                         | Inclusive range predicates             |
| `inArray`, `notInArray`                                         | Array or subquery membership           |
| `isNull`, `isNotNull`                                           | NULL checks                            |
| `exists`, `notExists`                                           | Subquery existence                     |
| `arrayContains`, `arrayContained`, `arrayOverlaps`              | PostgreSQL array operators             |
| `and`, `or`, `not`                                              | Boolean composition                    |
| `asc`, `desc`                                                   | Order terms                            |
| `count`, `countDistinct`, `sum`, `avg`, `min`, `max`            | Aggregates                             |
| `filter(aggregate, condition)`                                  | Conditional aggregate                  |
| `excluded(column)`                                              | Portable upsert proposed-row reference |
| `coalesce`, `greatest`, `least`                                 | Scalar expression helpers              |
| `now`, `dateTrunc`, `dateAdd`, `dateSub`, `dateBin`, `dateDiff` | Temporal helpers                       |
| `over`, `rank`, `denseRank`, `rowNumber`, `lag`, `lead`         | Window helpers                         |
| `arrayExpr`, `jsonExtract`, `jsonTable`                         | Array/JSON expression and FROM helpers |

`dateTrunc`, `dateBin`, and JSON/window helpers render per dialect and preserve
portable ordering/grouping semantics, but result value shapes can still differ
by engine; see the feature matrix for adapter-level details.

## Schema Snapshots

Snapshots are serializable, dialect-neutral schema descriptions consumed by DDL
generators and migration planning. `SCHEMA_SNAPSHOT_VERSION` is `2`.

| Helper                                               | Purpose                                   |
| ---------------------------------------------------- | ----------------------------------------- |
| `createSchemaSnapshot({ tables, ... })`              | Build from ORM tables                     |
| `defineSchemaSnapshot(input)`                        | Normalize and validate authored snapshots |
| `defineSchemaObject(object)`                         | Add trusted raw DDL objects to a snapshot |
| `validateSchemaSnapshot` / `assertValid...`          | Report or throw validation issues         |
| `normalizeSchemaSnapshot`                            | Deterministic sorted clone                |
| `serializeSchemaSnapshot` / `deserialize...`         | Canonical JSON round-trip                 |
| `equalSchemaSnapshots`                               | Normalized structural equality            |
| `diffSchemaSnapshots` / `isEmpty...`                 | Snapshot diffing                          |
| `selectSchemaObjects` / `schemaObjectDropStatements` | Dialect-gated raw DDL selection/drop      |

`createSchemaSnapshot` accepts `dialect`, `dialectVariant`, `dialectVersion`,
`metadata`, `tables`, and `schemaObjects`. Schema objects are emitted after
table/column/index/foreign-key creation by adapter DDL generators.

Core snapshot types include `SisalSchemaSnapshot`, `SisalTableSnapshot`,
`SisalColumnSnapshot`, `SisalColumnType`, `SisalColumnDefault`,
`SisalSchemaObjectSnapshot`, `SisalIndexSnapshot`, `SisalForeignKeySnapshot`,
`SisalSchemaSnapshotDiff`, and the related diff and issue types.

## Statement Assembly

`assembleSelect(parts)` and `assembleInsertFromSelect(parts)` are the core-only
statement assembly surface for downstream packages that need deterministic SQL
without depending on the ORM builders. They produce byte-identical SQL to the
fluent builder for the supported shapes: projected `SELECT`, grouped/having
selects, ordered/limited selects, and `INSERT INTO ... SELECT ...` with
dialect-mapped upsert.

## Capabilities

The capability registry is the source of truth for render-time and doc-matrix
dialect divergence:

| Export                         | Purpose                                                         |
| ------------------------------ | --------------------------------------------------------------- |
| `DIALECT_CAPABILITIES`         | Named capability declarations                                   |
| `CAPABILITY_TARGETS`           | `pg`, `neon`, `sqlite`, `libsql`, `mysql`, `mariadb` identities |
| `capabilitySupported(cap, id)` | Non-rendering support predicate                                 |
| `capabilityGuard(cap, label?)` | Render-time guard fragment                                      |
| `compareServerVersions(a, b)`  | Leading numeric server-version comparison                       |

Registered capabilities currently cover `RETURNING`, multi-table mutation forms,
`DISTINCT ON`, `FULL JOIN`, row locking, PostgreSQL array operators,
data-modifying CTEs, mutation CTEs, `GROUPS` window frames, `lag`/`lead`
defaults, and partial indexes.

## Errors And Logging

`SisalError` is the shared structured error (`code`, `status`, `expose`,
`severity`, `details`, redacted `cause`). `OrmError` specializes it for schema,
SQL, driver, transaction, and batch failures.

Logging exports include `Logger`, `LoggerMethod`, `SisalLoggingOptions`,
`SisalLogSettings`, `SisalLogLevel`, `SisalLogCategory`,
`createSisalLogEmitter`, `normalizeSisalLogSettings`, `logEnabled`,
`emitSisalLogEvent`, `redactSqlParameter`, and `redactSqlParameters`.

`logging.level: "debug"` emits SQL/timing categories; `"trace"` also emits
redacted bind summaries. The legacy `logger` option keeps the previous
debug/error behavior without bind logs unless structured `logging` is passed.

---

# `@sisal/orm`

`@sisal/orm` re-exports the stable `@sisal/core` API and adds the database
facade, fluent query builders, relation metadata, typed database-function calls,
test drivers, and atomic operation helpers. It stays driverless.

## Database Facade

```ts
function createDatabase(options?: {
  driver?: OrmDriver;
  dialect?: SqlDialect;
  variant?: string;
  version?: string;
  logger?: Logger;
  logging?: SisalLoggingOptions;
  schema?: DatabaseSchema;
  relations?: RelationsList;
  temporal?: { parse?: boolean };
}): Database;
```

`Database` exposes:

| Method/property                        | Purpose                                  |
| -------------------------------------- | ---------------------------------------- |
| `dialect` / `dialectIdentity`          | Render dialect plus variant/version      |
| callable `query(sql, params?)`         | Raw query returning a mappable promise   |
| `query.<table>.findMany/findFirst`     | Relation-aware table queries             |
| `execute(sql, params?)`                | Run manual or builder SQL                |
| `select`, `insert`, `update`, `delete` | Fluent builders                          |
| `$with`, `$withRecursive`, `with`      | CTE builders and CTE query roots         |
| `$count(table, where?)`                | Count rows as `number`                   |
| `call(fn, args)`                       | Typed database-function call             |
| `transaction(fn)`                      | Interactive transaction callback         |
| `batch(statements)`                    | Atomic, non-interactive statement batch  |
| `close()` / `[Symbol.asyncDispose]()`  | Release driver resources / `await using` |

Raw queries can map rows back through table metadata or a free-form column map:

```ts
const rows = await db.query(sql`select * from users`).as(users);
const totals = await db.query(sql`select count(*) as total from users`).as<{
  total: number;
}>({ total: { dataType: "integer" } });
```

`temporal.parse` defaults to `false`. When enabled, ORM-built queries and mapped
raw queries decode known date/time columns according to their declared mode.
Unmapped raw results keep the driver-returned shape.

## Query Builders

All builders are immutable and lazy. Use `.toSql()` to inspect, `.prepare()` to
bind named placeholders later, and `.execute()` to run.

| Builder                 | Main methods                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `SelectBuilder`         | `from`, joins, `where`, `groupBy`, `having`, `orderBy`, `limit`, `offset`, `keyset`, `for`, `as`, set ops |
| `CompoundSelectBuilder` | set ops, `orderBy`, `limit`, `offset`, `as`, `prepare`, `execute`                                         |
| `InsertBuilder`         | `values`, `select`, conflict helpers, `returning`, `prepare`, `execute`                                   |
| `UpdateBuilder`         | `set`, `from`, `where`, `unsafeAllowAllRows`, `returning`, `prepare`, `execute`                           |
| `DeleteBuilder`         | `using`, `where`, `unsafeAllowAllRows`, `returning`, `prepare`, `execute`                                 |
| `WithQueryBuilder`      | `select`, `insert`, `update`, `delete` with CTE prefix                                                    |

`update` and `delete` without `where` throw unless `.unsafeAllowAllRows()` is
called. `RETURNING`, `DISTINCT ON`, full joins, row locking, array operators,
and data-modifying CTEs are capability-guarded and throw typed `OrmError`s on
unsupported dialect identities.

Prepared queries use `placeholder(name)`:

```ts
const byId = db.select().from(users)
  .where(eq(users.columns.id, placeholder("id")))
  .prepare("user_by_id");

const rows = await byId.execute({ id: userId });
```

Keyset pagination returns `{ rows, nextCursor }` and should order by a unique
final tiebreaker:

```ts
const page = await db.select({
  id: posts.columns.id,
  score: posts.columns.score,
}).from(posts)
  .keyset({
    orderBy: [desc(posts.columns.score), desc(posts.columns.id)],
  })
  .limit(20)
  .execute();
```

## CTEs, Functions, And Atomic Operations

`db.$with(name).as(query)` creates a CTE from a select or a PostgreSQL-only
data-modifying mutation with `RETURNING`. `db.$withRecursive(name, columns)`
creates typed recursive CTE self-references.

`defineFunction(name, { args?, returns })` declares typed database functions.
`db.call(fn, args)` renders one `SELECT * FROM fn(args)` call and exposes
`.execute()` and `.one()`.

`defineAtomicOperation(name, bodyOrConfig)` packages domain operations behind
one `.run(db, input)` call. The portable `body` runs inside
`db.transaction(...)`; an optional `singleStatement` path runs on PostgreSQL
when present, usually as one data-modifying CTE statement for serverless
transports.

## Relations

`relations(table, ({ one, many }) => ({ ... }))` defines typed relation
metadata. Pass `schema` and `relations` into `createDatabase` or adapter
`connect` calls to enable `db.query.<schemaKey>.findMany/findFirst`.

```ts
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
});
```

`findFirst(config?)` adds `limit 1` and returns one row or `undefined`.

## Drivers

`OrmDriver` is the async adapter contract: `query`, `execute`, optional
`transaction`, optional `batch`, and optional `close`. `noopOrmDriver()` always
returns empty result sets. `memoryOrmDriver({ tables? })` is a tiny in-memory
test driver.

---

# `@sisal/migrate`

`@sisal/migrate` is adapter-neutral and depends on `@sisal/core`. It defines
migration records, checksums, planning, in-memory stores, a generic runner, the
filesystem workflow, drift checks, and the CLI.

## Definitions And Core Runner

```ts
defineSqlMigration({
  id: "0001_init",
  up: "create table ...",
  down: "drop table ...",
});

defineMigration({
  id: "0002_seed",
  up: async ({ driver }) => await driver.execute("insert ..."),
});
```

`MigrationStep` is SQL text, an array of SQL statements, or a callback that
receives `{ driver, logger, logging, dryRun, direction }`.

`createMigrator(options)` accepts `migrations`, `store`, `driver`, `logger`,
`logging`, `lockId`, `useTransaction`, and `splitStatements`. The returned
`Migrator` exposes `plan`, `up`, `down`, `pending`, `applied`, `close`, and
`[Symbol.asyncDispose]`.

Pure helpers include `calculateMigrationChecksum`, `assertMigrationChecksum`,
`createMigrationPlan`, `createAppliedMigration`, `sortMigrations`,
`validateMigration`, `validateMigrations`, `getPendingMigrations`,
`getAppliedMigrations`, `getRollbackMigrations`, `formatMigrationFilename`,
`slugifyMigrationName`, and `splitSqlStatements`.

## Planning And Drift

`planSchemaChanges({ from?, to })` and `planSchemaChangesFromDiff(diff)`
classify snapshot diffs into `SchemaChange[]` with `kind` values such as
`create_table`, `drop_table`, `add_column`, `drop_column`, and `alter_column`.
Drop/alter changes are marked destructive.

`checkDrift(input)` reports `schema_changed`, `pending_migrations`, and
`missing_snapshot` findings. `defineSchemaMigrationPlan({ from?, to })`
validates and normalizes schema pairs for migration planning.

## File Workflow

The workflow subpath (`@sisal/migrate/workflow`) is SQL-first and has an
injectable filesystem:

| Symbol                                             | Purpose                                     |
| -------------------------------------------------- | ------------------------------------------- |
| `MigrationFileSystem`                              | `readDir`, `readFile`, `writeFile`, `mkdir` |
| `denoMigrationFileSystem()`                        | Deno-backed implementation                  |
| `buildMigrationFile` / `writeMigrationFile`        | Create and write `.sql` + snapshot          |
| `readMigrationsDir`                                | Discover ordered migrations                 |
| `parseMigrationSequence` / `nextMigrationSequence` | Sequence helpers                            |
| `defineConfig(config)`                             | Validate `sisal.migrate.ts` config          |

`MigrateConfig` includes `dir`, `dialect`, optional `provider: "neon"`,
`snapshot`, `databaseUrl`, `databaseAuthToken`, `databasePath`, `historyTable`,
and default `logging`.

## CLI

`runSisalCli(args, options?)` powers the `sisal` executable. Commands are:

| Command          | Purpose                                  |
| ---------------- | ---------------------------------------- |
| `sisal init`     | Scaffold config and migrations dir       |
| `sisal generate` | Diff latest snapshot -> current snapshot |
| `sisal migrate`  | Apply pending SQL migrations             |
| `sisal status`   | Print files, DB plan, and drift findings |
| `sisal drift`    | Exit non-zero when drift findings exist  |

Targets: `postgres`, `neon`, `sqlite`, `libsql`, and `mysql` (`mariadb` is an
alias). `--dialect` accepts `postgres`, `sqlite`, or `mysql`; `--provider neon`
runs PostgreSQL DDL through the Neon adapter. Logging flags are `--log-level`,
`--quiet`, and repeatable `-v`/`--verbose` (`-v` = debug, `-vv` = trace).

`generate` emits only non-destructive SQL. Destructive drop/alter changes are
reported and withheld so captured snapshots do not get ahead of emitted SQL.

---

# `@sisal/etl`

`@sisal/etl` defines adapter-neutral rollup jobs on top of Sisal schema metadata
and SQL fragments. The job model and SQL compiler stay `@sisal/core`-based; the
runner APIs execute through a caller-supplied Sisal `Database`, so adapters stay
outside the package boundary.

## Jobs And SQL

- `defineJob(config)` validates the source table, target table, grain, window
  column, group keys, and aggregate projections.
- `rollup(job, window)` compiles a half-open window into the insert-from-select
  rollup SQL.
- `explain(job, window, options?)` returns the SQL and parameters without
  executing it.
- `supportsJob(job, identity)` and `assertJobSupported(job, identity)` apply the
  dialect support gate before execution.

## Windows And Runners

- `truncateToGrain`, `addGrain`, `windowAt`, `windowsInRange`, and `nextWindow`
  provide UTC bucket and half-open range helpers.
- `run(db, job, options?)` folds one checkpoint-driven window.
- `backfill(db, job, range, options?)` replays a deterministic historical range.
- `replay(db, job, window, options?)` re-runs one idempotent window.
- `status(db, job, options?)` reports checkpoint state and the next run window.

---

# `@sisal/analytics`

`@sisal/analytics` is the typed analytical query descriptor layer. It is
Postgres-first and rollup-first: ETL or application code prepares tables such as
hourly stats, then analytics describes dimensions, aggregate metrics, windowed
metrics, period-over-period comparisons, ordering, and limits over those
prepared shapes.

The package depends on `@sisal/core` only. `execute(db)` uses a structural
executor boundary: the object must provide `dialectIdentity` and `execute(Sql)`.
That keeps analytics free of ORM, adapter, driver, migrate, and ETL runtime
imports while still letting adapter `Database` instances execute rendered
queries.

## Query Builder

| Symbol           | Purpose                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| `from(source)`   | Start an immutable analytical query over a table, rollup, or source                                      |
| `AnalyticsQuery` | Query type with `dimensions`, `metrics`, `windows`, `where`, `orderBy`, `limit`, `render`, and `execute` |

`render(identity)` returns `{ text, params }` without executing. `execute(db)`
first applies the capability gate with `db.dialectIdentity`, then sends one
parameterized SQL statement to the structural executor.

## Dimensions And Metrics

| Symbol                  | Purpose                                                 |
| ----------------------- | ------------------------------------------------------- |
| `bucket(width, source)` | Time-bucket dimension helper over `dateTrunc`/`dateBin` |
| `count`                 | Count aggregate, re-exported from `@sisal/core`         |
| `sum`                   | Sum aggregate                                           |
| `avg`                   | Average aggregate                                       |
| `min`                   | Minimum aggregate                                       |
| `max`                   | Maximum aggregate                                       |
| `countDistinct`         | Distinct-count aggregate                                |
| `percentileCont`        | PostgreSQL ordered-set continuous percentile            |
| `percentileDisc`        | PostgreSQL ordered-set discrete percentile              |

The basic aggregate helpers render across the SQL families supported by the core
renderer. `percentileCont` and `percentileDisc` are experimental Postgres-first
helpers and fail closed elsewhere through `ANALYTICS_UNSUPPORTED_QUERY`.

## Windowed Metrics And Ordering

| Symbol       | Purpose                                      |
| ------------ | -------------------------------------------- |
| `movingAvg`  | Moving average over an existing metric       |
| `rank`       | SQL `rank()` window metric                   |
| `denseRank`  | SQL `dense_rank()` window metric             |
| `rowNumber`  | SQL `row_number()` window metric             |
| `lag`        | Previous-row value for a dimension or metric |
| `lead`       | Next-row value for a dimension or metric     |
| `delta`      | Difference between current and offset value  |
| `ascending`  | Analytics order term by descriptor key       |
| `descending` | Descending analytics order term by key       |

`compareToPreviousWindow(metricKey)` adds typed previous-window and delta fields
along the query's single `bucket()` dimension. Missing or ambiguous bucket axes
are rejected at declaration time.

## Capability Gates

| Symbol                                  | Purpose                                                                |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `supportsQuery(query, identity)`        | Dry-run support report for a dialect identity                          |
| `assertQuerySupported(query, identity)` | Throws `ANALYTICS_UNSUPPORTED_QUERY` before execution when unsupported |

Current analytics support is intentionally honest: PostgreSQL is the primary
target, portable render support is unit/golden-SQL proven for the non-percentile
subset, and live integration coverage is called out separately in the feature
matrix once present.

---

# Adapter Packages

Every adapter root re-exports its ORM helpers, migration facade, and pure DDL
generator. Narrower imports (`@sisal/<adapter>/orm`, `/migrate`, `/ddl`) keep
application boundaries explicit.

## Shared Adapter Patterns

Adapter database facades (`PgDatabase`, `NeonDatabase`, `SqliteDatabase`,
`LibsqlDatabase`, `MysqlDatabase`) extend `Database` and support `close()` plus
`[Symbol.asyncDispose]()` through the ORM facade.

Adapter migration facades expose:

```ts
interface AdapterMigrator {
  migrate(options: { migrations: readonly MigrationInput[] /* run opts */ });
  rollback(options: { migrations: readonly MigrationInput[] /* down opts */ });
  plan(options: { migrations: readonly MigrationInput[] });
  applied();
  close();
  [Symbol.asyncDispose]();
}
```

All DDL generators return `{ statements, destructive }`, emit only additive
changes (`CREATE TABLE`, `ADD COLUMN`, indexes, foreign keys, schema objects),
and withhold destructive changes for explicit handling.

## `@sisal/pg`

PostgreSQL adapter. ORM exports:

| Symbol                   | Purpose                      |
| ------------------------ | ---------------------------- |
| `connect` / `createPgDb` | Open a `PgDatabase`          |
| `createPgOrmDriver`      | Build an ORM driver          |
| `createPgExecutor`       | Lower-level SQL executor     |
| `createPgPool`           | `@db/postgres` pool          |
| `createPostgresJsPool`   | Optional `npm:postgres` pool |
| `POSTGRES_DIALECT`       | `"postgres"`                 |

Migration exports include `createPgMigrator`, `createPgMigrationDriver`,
`createPgMigrationHistoryStore`, `DEFAULT_PG_MIGRATION_TABLE`,
`createPgExecutor`, and `createPgPool`.

DDL exports: `generatePostgresUpStatements`, `generatePostgresCreateTable`,
`generatePostgresAddColumn`, `generatePostgresColumnDefinition`,
`generatePostgresColumnType`, `generatePostgresIndexes`,
`generatePostgresForeignKeys`, `quotePgIdent`, and `pgQualifiedName`.

## `@sisal/neon`

Neon serverless PostgreSQL adapter. ORM exports include `connect`,
`createNeonDb`, `createNeonPool`, `createNeonClient`, `createNeonExecutor`,
`neonPoolConfigFromOptions`, `neonClientConfigFromOptions`,
`resolveNeonConnectionString`, `normalizeNeonResult`, `NeonError`, and
`POSTGRES_DIALECT`.

`createNeonMigrator` delegates to the PostgreSQL migrator with a Neon executor.
Its defaults are serverless-oriented: `useTransaction` defaults to `false` and
`splitStatements` defaults to `true`. `DEFAULT_NEON_MIGRATION_TABLE` matches the
PostgreSQL history table default.

`@sisal/neon/ddl` re-exports the PostgreSQL DDL helpers.

## `@sisal/sqlite`

SQLite adapter. ORM exports include `connect`, `createSqliteDb`,
`createSqliteOrmDriver`, `createSqliteExecutor`, `openSqliteDatabase`,
`statementReturnsRows`, `sqliteColumnAffinity`, and `SQLITE_DIALECT`.
`@db/sqlite` is opened lazily only when no executor or existing database is
injected.

Migration exports include `createSqliteMigrator`, `createSqliteMigrationDriver`,
`createSqliteMigrationHistoryStore`, `DEFAULT_SQLITE_MIGRATION_TABLE`, and the
SQLite executor/database helpers.

DDL exports: `generateSqliteUpStatements`, `generateSqliteCreateTable`,
`generateSqliteAddColumn`, `generateSqliteColumnDefinition`,
`generateSqliteColumnType`, `generateSqliteIndexes`, and `quoteSqliteIdent`.
SQLite DDL maps higher-level types onto SQLite affinities and withholds
destructive changes for table-rebuild workflows.

## `@sisal/libsql`

libSQL/Turso adapter. ORM exports include `connect`, `createLibsqlDb`,
`createLibsqlOrmDriver`, `createLibsqlExecutor`, `openLibsqlClient`,
`createLibsqlClient`, `isLibsqlUrl`, `libsqlConfigFromOptions`, and
`LIBSQL_DIALECT`.

Migration exports include `createLibsqlMigrator`, `createLibsqlMigrationDriver`,
`createLibsqlMigrationHistoryStore`, `DEFAULT_LIBSQL_MIGRATION_TABLE`, and the
libSQL client/executor helpers.

`@sisal/libsql/ddl` provides SQLite-compatible aliases:
`generateLibsqlUpStatements`, `generateLibsqlCreateTable`,
`generateLibsqlAddColumn`, `generateLibsqlColumnDefinition`,
`generateLibsqlColumnType`, and `quoteLibsqlIdent`.

## `@sisal/mysql`

MySQL/MariaDB adapter. ORM exports:

| Symbol                              | Purpose                                      |
| ----------------------------------- | -------------------------------------------- |
| `connect` / `createMysqlDb`         | Open a `MysqlDatabase`                       |
| `createMysqlOrmDriver`              | Build an ORM driver                          |
| `createMysqlExecutor`               | Lower-level SQL executor                     |
| `createMysqlPool`                   | Lazy `npm:mysql2` pool                       |
| `createMariadbPool`                 | Lazy `npm:mariadb` pool                      |
| `adaptMariadbPool`                  | Adapt MariaDB connector pools                |
| `parseMysqlServerVersion`           | Detect MariaDB variant/version               |
| `insertReturning`                   | Fetch inserted rows with best available path |
| `MYSQL_DIALECT` / `MARIADB_VARIANT` | Dialect identity constants                   |

`connect({ driver: "mariadb" })` opts into the MariaDB connector; mysql2 is the
default. The adapter detects `select version()` and fills
`dialectIdentity.variant/version`, which lets version-gated capabilities such as
MariaDB `RETURNING` light up.

`insertReturning(db, table, values)` first tries real `INSERT ... RETURNING`
when supported (MariaDB >= 10.5), then falls back to a transactionally safe
fetch-by-primary-key strategy. The fallback refuses cases where it cannot
identify the inserted rows correctly.

Migration exports include `createMysqlMigrator`, `createMysqlMigrationDriver`,
`createMysqlMigrationHistoryStore`, `createMysqlMigrateExecutor`, and
`DEFAULT_MYSQL_MIGRATION_TABLE`. `CreateMysqlMigratorOptions.useTransaction`
defaults to `false` because MySQL and MariaDB do not provide transactional DDL.

DDL exports: `generateMysqlUpStatements`, `generateMysqlCreateTable`,
`generateMysqlAddColumn`, `generateMysqlColumnDefinition`,
`generateMysqlColumnType`, `generateMysqlIndexes`, `generateMysqlForeignKeys`,
`quoteMysqlIdent`, and `mysqlQualifiedName`. The generator targets the shared
MySQL/MariaDB floor, emits foreign keys after table creation, rejects
unsupported partial/functional indexes, rejects keyed `TEXT`/`BLOB`/`JSON`
columns that need prefix lengths, and validates `AUTO_INCREMENT` key rules
before emitting SQL.
