---
title: Drizzle Parity
---

# Sisal ↔ Drizzle ORM 0.45.2 parity

This is the guiding document for how Sisal's API evolves. It maps every relevant
part of the [Drizzle ORM 0.45.2](https://orm.drizzle.team) surface to Sisal,
records where we intentionally diverge, and lays out the roadmap to close the
gaps that matter.

It is paired with executable parity tests so the map cannot silently rot:

```text
packages/orm/drizzle_parity_test.ts      operators, columns, builders, sql, inference
packages/pg/drizzle_parity_test.ts       Postgres type mapping + CREATE TABLE
packages/sqlite/drizzle_parity_test.ts   SQLite affinity mapping + CREATE TABLE
```

Run them with `deno task test`. Each "roadmap" test asserts that a Drizzle
feature we have **not** built is still absent; when you implement one of those,
the test fails and points you back here to move the row from ❌ to ✅.

## Status legend

| Symbol | Meaning                                                         |
| ------ | --------------------------------------------------------------- |
| ✅     | Parity — same capability, equivalent behavior                   |
| 🟡     | Partial — present but narrower than Drizzle                     |
| 🔷     | Divergent **by design** — we chose a different shape on purpose |
| ❌     | Gap — not implemented yet; on the roadmap                       |

## Guiding principles

1. **Match Drizzle's vocabulary where it is good.** Operator names (`eq`, `and`,
   `inArray`), the `sql` tag, and the `select/insert/update/delete` chain are
   familiar and worth keeping identical so the learning curve is near zero.
2. **Diverge only with a reason, and write the reason down.** Sisal favors
   explicit safety and a smaller surface over Drizzle's breadth. Every 🔷 row
   below has a justification.
3. **Stay driverless at the core.** Parity is measured against `@sisal/orm` plus
   the adapters; we will not adopt Drizzle features that require coupling the
   ORM to a driver.
4. **Snapshots over codegen — for now.** Drizzle leans on the `drizzle-kit` CLI;
   Sisal leans on serializable schema snapshots and pure DDL generators. A CLI
   is a roadmap item, not a reason to change the core.

---

## 1. Schema & columns

### Table definition

| Drizzle 0.45.2                           | Sisal                                                                           | Status |
| ---------------------------------------- | ------------------------------------------------------------------------------- | ------ |
| `pgTable(name, cols)`                    | `defineTable(name, cols)`                                                       | 🔷     |
| `sqliteTable` / `mysqlTable`             | `defineTable(name, cols, { schema })` (dialect chosen at snapshot/adapter time) | 🔷     |
| `table.columnName` (direct access)       | `table.columns.columnName`                                                      | 🔷     |
| `t.$inferSelect` / `t.$inferInsert`      | `InferSelect<typeof t>` / `InferInsert<typeof t>`                               | 🔷     |
| `getTableColumns(t)` / `getTableName(t)` | same names                                                                      | ✅     |

**Divergences, justified.** Sisal uses one dialect-neutral `defineTable` and
resolves the dialect later (at snapshot/adapter time) instead of three
per-dialect builders. Columns are reached via `.columns.x` so the table object
can stay a small, frozen, introspectable record. Type inference is via exported
generic types rather than phantom properties on the value.

### Column types

| Drizzle (`pg-core`)           | Sisal                                            | Status |
| ----------------------------- | ------------------------------------------------ | ------ |
| `text`                        | `columns.text()`                                 | ✅     |
| `varchar({ length })`         | `columns.varchar(n)`                             | ✅     |
| `integer`                     | `columns.integer()`                              | ✅     |
| `bigint({ mode })`            | `columns.bigint()` (string-typed)                | 🟡     |
| `boolean`                     | `columns.boolean()`                              | ✅     |
| `timestamp({ withTimezone })` | `columns.timestamp({ withTimezone })`            | ✅     |
| `date`                        | `columns.date()`                                 | ✅     |
| `uuid`                        | `columns.uuid()`                                 | ✅     |
| `json` / `jsonb`              | `columns.json<T>()` / `columns.jsonb<T>()`       | ✅     |
| `serial` / `bigserial`        | `columns.serial()` / `columns.bigserial()`       | ✅     |
| `real` / `doublePrecision`    | `columns.real()` / `columns.doublePrecision()`   | ✅     |
| `numeric` / `decimal`         | `columns.numeric(p, s)` / `columns.decimal(...)` | ✅     |
| `char`                        | `columns.char(n)`                                | ✅     |
| `smallint`                    | `columns.smallint()`                             | ✅     |
| `bytea` / `blob`              | `columns.bytea()` (pg `bytea`, sqlite `BLOB`)    | ✅     |
| `*.array()`                   | `.array()`                                       | ✅     |
| custom `pgEnum`               | —                                                | ❌     |

`numeric`/`decimal`/`bigint`/`bigserial` are string-typed to preserve precision.
`serial`/`bigserial` are optional on insert (DB-generated). `.array()` emits
Postgres `type[]`; SQLite stores it under the element's affinity. Remaining
column gap: `pgEnum`.

### Column modifiers

| Drizzle 0.45.2                  | Sisal                                        | Status |
| ------------------------------- | -------------------------------------------- | ------ |
| `.notNull()`                    | `.notNull()` (opt out of nullable default)   | ✅     |
| `.default(v)`                   | `.default(v \| () => v)`                     | ✅     |
| `.$default()` / `.$defaultFn()` | `.default(() => v)` covers both              | 🟡     |
| `.primaryKey()`                 | `.primaryKey()` (implies `.notNull()`)       | ✅     |
| `.unique()`                     | `.unique()`                                  | ✅     |
| `.references(() => t.col)`      | `.references("table", "column")`             | 🔷     |
| `.$type<T>()`                   | type param on factory (`columns.json<T>()`)  | 🔷     |
| `.array()`                      | `.array()`                                   | ✅     |
| `.$onUpdate(fn)`                | `.$onUpdate(fn)` (applied on `UPDATE`)       | ✅     |
| `.generatedAlwaysAs(...)`       | —                                            | ❌     |
| (no equivalent)                 | `.nullable()` (explicit form of the default) | 🔷     |
| (no equivalent)                 | `.optional()` (insert-optional)              | 🔷     |
| (no equivalent)                 | `.named(name)`                               | 🔷     |

### ✅ Nullability default — aligned with Drizzle

> **Columns are nullable by default**, matching SQL and Drizzle. Call
> `.notNull()` to require a value; `.primaryKey()` implies it.

A column's inferred value type is `T | null` until narrowed by
`.notNull()`/`.primaryKey()`. The one axis that stays separate is insert
optionality: `.optional()` makes a field omittable **on insert** but does not
change nullability, and (unlike Drizzle) a plain nullable column is still
required on insert unless it is `.optional()` or has a `.default()`. This
behavior is asserted by `parity: columns are nullable by default` in the ORM
parity test.

---

## 2. Filter operators

| Drizzle 0.45.2                                     | Sisal           | Status |
| -------------------------------------------------- | --------------- | ------ |
| `eq`, `ne`                                         | `eq`, `ne`      | ✅     |
| `gt`, `gte`, `lt`, `lte`                           | same            | ✅     |
| `like`, `ilike`                                    | `like`, `ilike` | ✅     |
| `inArray`, `notInArray`                            | same            | ✅¹    |
| `isNull`, `isNotNull`                              | same            | ✅     |
| `and`, `or`, `not`                                 | same            | ✅²    |
| `between`, `notBetween`                            | same            | ✅     |
| `notLike`, `notIlike`                              | same            | ✅     |
| `asc`, `desc` (order helpers)                      | same            | ✅     |
| `count`, `sum`, `avg`, `min`, `max`                | same            | ✅³    |
| `exists`, `notExists`                              | —               | ❌     |
| `arrayContains`, `arrayContained`, `arrayOverlaps` | —               | ❌     |

¹ **Divergence:** Drizzle throws on an empty `inArray`; Sisal returns a constant
condition (`1 = 0` / `1 = 1`) so dynamic filters with no values are safe.

² **Divergence:** Sisal's `and`/`or` silently ignore `null`/`undefined`
arguments, so conditional filters need no pre-filtering.

³ Aggregates return a typed `SqlExpression<T>` for use in select projections
(`db.select({ total: count() })`); `count()` infers `number`, `sum`/`avg` infer
`number | null`, `min`/`max` infer `T | null`.

**Output divergence:** Sisal always renders column references **table-qualified
and parameterized** (`"users"."id" = $1`), where Drizzle may emit a bare
`"id" = 42`. Behavior is equivalent; the text differs.

---

## 3. Query builder

| Drizzle 0.45.2                           | Sisal                            | Status |
| ---------------------------------------- | -------------------------------- | ------ |
| `db.select().from(t)`                    | same                             | ✅     |
| `db.select({ projection })`              | same                             | ✅     |
| `.where(...)`                            | same                             | ✅     |
| `.orderBy(asc(c), desc(c))`              | same, plus `.orderBy(c, "desc")` | ✅     |
| `.limit(n)` / `.offset(n)`               | same                             | ✅     |
| `.innerJoin` / `.leftJoin`               | same                             | ✅     |
| `.rightJoin` / `.fullJoin`               | same                             | ✅     |
| `.groupBy(...)` / `.having(...)`         | same                             | ✅     |
| `.distinct()`                            | same                             | ✅     |
| `.$dynamic()`                            | —                                | ❌     |
| `db.insert(t).values(v)`                 | same                             | ✅     |
| `.returning(projection?)`                | same                             | ✅     |
| `.onConflictDoNothing/DoUpdate`          | same (`on conflict …`)           | ✅⁴    |
| `db.update(t).set(v).where(...)`         | same                             | ✅     |
| `db.delete(t).where(...)`                | same                             | ✅     |
| update/delete without `where`            | allowed (full-table)             | 🔷     |
| `db.transaction(fn)`                     | same                             | ✅     |
| Relational queries `db.query.t.findMany` | `relations()` + `db.query.t`     | ✅     |

**Divergence (safety):** a `where`-less `update`/`delete` throws in Sisal unless
you call `.unsafeAllowAllRows()`. Drizzle runs it. We consider the rail worth
the friction.

⁴ Upserts emit Postgres/SQLite
`ON CONFLICT (target) DO NOTHING / DO UPDATE SET
… [WHERE …]`. MySQL's
`ON DUPLICATE KEY UPDATE` is out of scope until a MySQL adapter exists. `target`
accepts a column, a column name, or an array of either.

`.orderBy` accepts both the legacy `(column, "asc" | "desc")` form and one or
more `asc()`/`desc()` terms (or bare columns), e.g.
`orderBy(desc(t.columns.createdAt), asc(t.columns.name))`.

Relational queries are enabled with `createDatabase({ schema, relations })`.
`db.query` remains callable for raw SQL (``db.query(sql`...`)``) and gains
schema-keyed helpers (`db.query.users.findMany(...)`) when a schema map is
provided.

---

## 4. Typed SQL

| Drizzle 0.45.2                     | Sisal                 | Status |
| ---------------------------------- | --------------------- | ------ |
| `` sql`...` ``                     | `` sql`...` ``        | ✅     |
| `sql.raw(s)`                       | `raw(s)`              | ✅     |
| `sql.identifier(s)`                | `identifier(s)`       | ✅     |
| `sql.join(parts, sep)`             | `joinSql(parts, sep)` | ✅     |
| `sql.empty()`                      | `emptySql()`          | ✅     |
| `sql.placeholder(name)`            | —                     | ❌     |
| prepared statements / `.prepare()` | —                     | ❌     |

Names are namespaced as standalone functions rather than methods on `sql`, but
the capabilities line up.

---

## 5. Migrations

This is the area where Sisal deliberately looks least like Drizzle. Drizzle
splits runtime `migrate()` from the `drizzle-kit` CLI (`generate`, `migrate`,
`push`, `studio`). Sisal keeps everything in-library around schema snapshots.

| Drizzle 0.45.2                      | Sisal                                                   | Status |
| ----------------------------------- | ------------------------------------------------------- | ------ |
| `migrate(db, { migrationsFolder })` | `createMigrator(...).up()` / adapter `createPgMigrator` | 🔷     |
| `drizzle-kit generate`              | `sisal generate` + `generate*UpStatements`              | ✅     |
| `drizzle-kit migrate`               | `sisal migrate`                                         | ✅     |
| `drizzle-kit push`                  | —                                                       | ❌     |
| `drizzle-kit studio`                | —                                                       | ❌     |
| journal / snapshot files            | `.snapshot.json` + `readMigrationsDir`                  | 🔷     |
| checksum drift detection            | `checkDrift` + checksum mismatch in `plan()`            | ✅     |
| destructive change handling         | always withheld + returned in `destructive`             | 🔷     |

Sisal additionally offers programmatic migrations, advisory-locked runs, dry
runs, and `down`/`to` rollback — all adapter-neutral.

---

## 6. Adapters / connection

| Drizzle 0.45.2                         | Sisal                                              | Status |
| -------------------------------------- | -------------------------------------------------- | ------ |
| `drizzle(client)` (per driver package) | `createPgDb` / `createSqliteDb` / `createLibsqlDb` | 🔷     |
| `node-postgres` / `postgres-js` / etc. | `@db/postgres`-compatible client                   | 🟡     |
| `better-sqlite3` / `d1`                | `@db/sqlite` (lazy)                                | 🟡     |
| `libsql` / Turso                       | `@libsql/client` via `@sisal/libsql`               | ✅     |
| `mysql2`                               | — (snapshot/dialect aware, no adapter)             | ❌     |

---

## Roadmap

Ordered by leverage. Each item names the parity test(s) that will flip when it
lands.

### P0 — nullability default ✅ done

Columns are now **nullable by default** (`.notNull()` opts out, `.primaryKey()`
implies not-null), matching SQL and Drizzle. Pinned by
`parity: columns are
nullable by default` in the ORM parity test. Remaining
sub-item: decide whether a plain nullable column should also become
insert-optional like Drizzle (today it stays required unless
`.optional()`/`.default()`).

### P1 — operator & ordering parity ✅ done

- `between`, `notBetween`, `notLike`, `notIlike` added.
- `asc(col)` / `desc(col)` added; `orderBy` now takes multiple terms (and keeps
  the legacy `(col, "asc" | "desc")` form).
- Aggregate helpers `count`, `sum`, `avg`, `min`, `max` added, returning a typed
  `SqlExpression<T>` usable in select projections.
- _Tests:_ `parity: between / notBetween`, `parity: notLike / notIlike`,
  `parity: asc() / desc() ordering helpers + multi-column orderBy`,
  `parity: aggregate helpers (count/sum/avg/min/max)` in the ORM parity test.

### P2 — query builder breadth ✅ done

- `onConflictDoNothing` / `onConflictDoUpdate` (upserts) added.
- `groupBy` / `having` and `distinct` added.
- `rightJoin` / `fullJoin` added.
- _Tests:_ `parity: builder methods present (...)`,
  `parity: distinct + right/full
  joins render`, `parity: groupBy + having`,
  `parity: onConflictDoNothing /
  onConflictDoUpdate (upsert)` in the ORM
  parity test.
- Remaining builder gap: `.$dynamic()`.

### P3 — column surface ✅ done

- Exposed `numeric`/`decimal`, `char`, `smallint`, `serial`, `bigserial`,
  `real`, `doublePrecision`, and `.array()` on the builder.
- Added `.$onUpdate()`, applied automatically in the update builder.
- _Tests:_ `parity: new column types render in DDL via snapshot` and
  `parity: .$onUpdate() injects a value on UPDATE` in the ORM parity test.
- Remaining column gap: `pgEnum` and `.generatedAlwaysAs()`.

### P4 — relational queries ✅ done

- `relations()` added with `one()` / `many()` helpers, explicit
  `fields`/`references`, and simple foreign-key inference.
- `createDatabase({ schema, relations })` now exposes
  `db.query.table.findMany/findFirst` with `with` and `columns` while preserving
  raw `db.query(sql)` execution.
- _Tests:_
  `parity: relations() + db.query.table.findMany/findFirst with
  with/columns`
  in the ORM parity test.

### P5 — tooling ✅ done

`sisal init`, `sisal generate`, `sisal migrate`, `sisal status`, and
`sisal
drift` wrap the existing workflow helpers. `init` scaffolds
`sisal.migrate.ts` and the migrations directory; `generate` writes additive SQL
plus the matching `.snapshot.json` and refuses destructive diffs instead of
recording a snapshot that the generated SQL cannot actually produce. Tests live
in `packages/migrate/cli_test.ts`. Stretch goals still open: `rollback` (needs
the SQL-first workflow to also persist `down` statements), `push`, and a
studio-like inspector.

---

## Keeping this document honest

- When you implement a roadmap item, update its row to ✅/🟡 **and** adjust the
  matching parity test (remove the symbol from the "absent" list or add a
  behavioral assertion).
- When you add a deliberate divergence, add a 🔷 row with its justification.
- The parity tests are the enforcement layer; this document is the explanation.
  They are meant to change together in the same commit.
