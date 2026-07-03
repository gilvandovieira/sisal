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
packages/orm/drizzle_parity/*_test.ts    operators, columns, builders, relations, sql, inference
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

| Drizzle (`pg-core`)                            | Sisal                                                  | Status |
| ---------------------------------------------- | ------------------------------------------------------ | ------ |
| `text`                                         | `columns.text()`                                       | ✅     |
| `varchar({ length })`                          | `columns.varchar(n)`                                   | ✅     |
| `integer`                                      | `columns.integer()`                                    | ✅     |
| `bigint({ mode })`                             | `columns.bigint()` (string-typed)                      | 🟡     |
| `boolean`                                      | `columns.boolean()`                                    | ✅     |
| `timestamp({ withTimezone, mode })`            | `columns.timestamp({ withTimezone, mode })`            | ✅     |
| `date`                                         | `columns.date({ mode? })`                              | ✅     |
| `time`                                         | `columns.time({ mode? })`                              | ✅     |
| `uuid`                                         | `columns.uuid()`                                       | ✅     |
| `json` / `jsonb`                               | `columns.json<T>()` / `columns.jsonb<T>()`             | ✅     |
| `serial` / `bigserial`                         | `columns.serial()` / `columns.bigserial()`             | ✅     |
| `real` / `doublePrecision`                     | `columns.real()` / `columns.doublePrecision()`         | ✅     |
| `numeric` / `decimal`                          | `columns.numeric(p, s)` / `columns.decimal(...)`       | ✅     |
| `char`                                         | `columns.char(n)`                                      | ✅     |
| `smallint`                                     | `columns.smallint()`                                   | ✅     |
| `bytea` / `blob`                               | `columns.bytea()` (pg `bytea`, sqlite `BLOB`)          | ✅     |
| `*.array()`                                    | `.array()`                                             | ✅     |
| custom `pgEnum`                                | `columns.customType<T>({ kind: "enum", dialectType })` | 🟡     |
| `interval`                                     | `columns.customType<T>({ kind, dialectType })`         | ✅     |
| `generatedAlwaysAsIdentity()`                  | `columns.customType<number>(...).optional()`           | ✅     |
| `customType(...)`                              | `columns.customType<T>({ kind, dialectType })`         | ✅     |
| `point`/geometry/`inet`/`vector`/`bit`/`money` | `columns.customType<T>({ kind, dialectType })`         | ✅     |

`numeric`/`decimal`/`bigint`/`bigserial` are string-typed to preserve precision.
`serial`/`bigserial` are optional on insert (DB-generated). `.array()` emits
Postgres `type[]`; SQLite stores it under the element's affinity.
`columns.customType<T>({ kind, dialectType })` is the trusted escape hatch for
dialect-specific DDL types; Postgres emits `dialectType` verbatim, while SQLite
continues to map by affinity from `kind`. For Postgres/Neon, `customType` covers
the remaining type-emission rows in this table. The only partial row left here
is `pgEnum`: enum **columns** can point at an existing enum type, but Sisal does
not yet create/drop Postgres enum types as structured schema objects. Identity
DDL is reachable through `customType`, but Sisal does not yet model it as
structured metadata beyond the trusted dialect type string:

Date/time columns default to Temporal rather than JS `Date`: SQL `date` maps to
`Temporal.PlainDate`, `time` to `Temporal.PlainTime`, `timestamp` to
`Temporal.PlainDateTime`, and `timestamptz` to `Temporal.Instant`. Use
`mode: "date"` for legacy JS `Date` behavior or `mode: "string"` for raw text.
Postgres DDL now emits `timestamp` for `columns.timestamp()` and `timestamptz`
only when `withTimezone: true`.

```ts
columns.customType<number>({
  kind: "integer",
  dialectType: "integer generated always as identity",
}).optional();
```

### Column modifiers

| Drizzle 0.45.2                       | Sisal                                                               | Status |
| ------------------------------------ | ------------------------------------------------------------------- | ------ |
| `.notNull()`                         | `.notNull()` (opt out of nullable default)                          | ✅     |
| `.default(v)` / `.default(sql\`…\`)` | `.default(v \| () => v \| sql\`…\`)` (literal/client/server)        | ✅     |
| `.$default()` / `.$defaultFn()`      | `.default(() => v)` covers both                                     | 🟡     |
| `.primaryKey()`                      | `.primaryKey()` (implies `.notNull()`)                              | ✅     |
| `.unique()`                          | `.unique()` → emits a `UNIQUE` constraint                           | ✅     |
| `.references(() => t.col)`           | `.references(t, c, { onDelete?, onUpdate? })` → `FOREIGN KEY`       | ✅⁵    |
| `.$type<T>()`                        | type param on factory (`columns.json<T>()`)                         | 🔷     |
| `.array()`                           | `.array()`                                                          | ✅     |
| `.$onUpdate(fn)`                     | `.$onUpdate(fn)` (applied on `UPDATE`)                              | ✅     |
| `.generatedAlwaysAs(...)`            | —                                                                   | ❌     |
| (no equivalent)                      | `.nullable()` (explicit form of the default)                        | 🔷     |
| (no equivalent)                      | `.optional()` (insert-optional)                                     | 🔷     |
| `integer("name")` explicit name      | `.named("name")` (explicit physical column name)                    | ✅     |
| `casing: "snake_case"` (db)          | `naming` strategy + `setDefaultColumnNaming` (default `snake_case`) | ✅⁷    |

⁵ **Constraint emission strategy.** `.unique()` emits a `UNIQUE` constraint and
`.references(table, column, { onDelete?, onUpdate? })` emits a `FOREIGN KEY`
with optional `ON DELETE`/`ON UPDATE` actions. On **Postgres**, foreign keys are
emitted as `ALTER TABLE … ADD … FOREIGN KEY` _after_ every `CREATE TABLE`, so
the snapshot's alphabetical table order never causes a forward-reference error;
on **SQLite** they stay inline (SQLite allows forward references). Still pending
under [**P6**](#p6--schema-constraints--indexes--in-progress): composite /
table-level primary keys, named/composite unique constraints, indexes, and
`check`.

⁷ **Casing default — divergence by design.** Sisal applies `snake_case` to
column names **by default** (the JS key stays camelCase, the physical column is
`snake_case`, and `SELECT *`/`RETURNING *` alias back to the key on read).
Drizzle applies **no** casing unless you opt into `casing: "snake_case"`. So
`naming: "snake_case"` (per table) — and the global default — match Drizzle's
`casing: "snake_case"`, while `naming: "preserve"` matches Drizzle's verbatim
default. Set the process-wide default with `setDefaultColumnNaming(strategy)`
(applies to tables defined after the call); override per table with the `naming`
option, or per column with `.named(...)` (which always wins). Asserted by
`parity: column casing (naming strategy ~ Drizzle \`casing\`)`.

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

### Constraints & indexes

| Drizzle 0.45.2                                                      | Sisal                                           | Status |
| ------------------------------------------------------------------- | ----------------------------------------------- | ------ |
| column `.unique()` / `.references()`                                | emitted (`UNIQUE` / `FOREIGN KEY`)              | ✅⁵    |
| FK actions `onDelete` / `onUpdate`                                  | `.references(t, c, { onDelete, onUpdate })`     | ✅     |
| table PK `primaryKey({ columns })` (composite)                      | `primaryKey({ columns })` extras callback       | ✅⁶    |
| named / composite `unique('n').on(a, b)`                            | `unique('n').on(a, b)` extras callback          | ✅⁶    |
| `index()` / `uniqueIndex()` (+ `.on(col.desc())`, `.where()`, expr) | `index('n').on(asc/desc, sql\`…\`)`/`.where(…)` | ✅⁶    |
| `check('n', sql\`…\`)`                                              | `check('n', sql\`…\`)` extras callback          | ✅⁶    |

⁶ **Table-level constraints use a `defineTable` extras callback**,
Drizzle-style: `defineTable(name, columns, (t) => [...])`. The callback returns
primary keys, unique constraints, indexes, unique indexes, and checks. `UNIQUE`
/ `CHECK` emit inline in `CREATE TABLE` (check columns rendered unqualified for
portability); indexes emit as separate `CREATE INDEX` statements (auto-named
when unnamed).

**Indexes are rich:** `.on(...)` accepts `asc()` / `desc()` terms (per-column
`ASC` / `DESC` ordering) and `Sql` expression keys (an expression index), and
`.where(predicate)` adds a partial-index `WHERE` clause:

```ts
index("hot")
  .where(sql`${t.status} = "published"`)
  .on(desc(t.hotScore), desc(t.id));
uniqueIndex().on(sql`lower(${t.email})`);
```

Emitted across Postgres, SQLite, and libSQL.

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
| `countDistinct`                                    | same            | ✅⁷    |
| `exists`, `notExists`                              | same            | ✅     |
| `arrayContains`, `arrayContained`, `arrayOverlaps` | same            | ✅⁸    |

¹ **Divergence:** Drizzle throws on an empty `inArray`; Sisal returns a constant
condition (`1 = 0` / `1 = 1`) so dynamic filters with no values are safe.

² **Divergence:** Sisal's `and`/`or` silently ignore `null`/`undefined`
arguments, so conditional filters need no pre-filtering.

³ Aggregates return a typed `SqlExpression<T>` for use in select projections
(`db.select({ total: count() })`); `count()` infers `number`, `sum`/`avg` infer
`number | null`, `min`/`max` infer `T | null`.

⁸ `exists`/`notExists` take a select subquery and render `EXISTS (…)` /
`NOT EXISTS (…)`. The array operators are **Postgres-only** — `arrayContains`
(`@>`), `arrayContained` (`<@`), and `arrayOverlaps` (`&&`) emit the Postgres
array operators; SQLite/libSQL/MySQL have no equivalent, so rendering one for a
SQLite-family dialect throws a typed `OrmError` (see the
[feature-matrix limits](feature-matrix.md#postgresql-only-limits)).

**Output divergence:** Sisal always renders column references **table-qualified
and parameterized** (`"users"."id" = $1`), where Drizzle may emit a bare
`"id" = 42`. Behavior is equivalent; the text differs.

---

## 3. Query builder

| Drizzle 0.45.2                              | Sisal                                   | Status |
| ------------------------------------------- | --------------------------------------- | ------ |
| `db.select().from(t)`                       | same                                    | ✅     |
| `db.select({ projection })`                 | same                                    | ✅     |
| `.where(...)`                               | same                                    | ✅     |
| `.orderBy(asc(c), desc(c))`                 | same, plus `.orderBy(c, "desc")`        | ✅     |
| `.limit(n)` / `.offset(n)`                  | same                                    | ✅     |
| `.innerJoin` / `.leftJoin`                  | same                                    | ✅     |
| `.rightJoin` / `.fullJoin`                  | same                                    | ✅     |
| `.groupBy(...)` / `.having(...)`            | same                                    | ✅     |
| `.distinct()`                               | same                                    | ✅     |
| `db.$with(n).as(q)` + `db.with(c)`          | same — fluent CTEs                      | ✅⁵    |
| `union` / `unionAll`                        | `.union()` / `.unionAll()`              | ✅⁵    |
| `intersect` / `intersectAll`                | `.intersect()` / `.intersectAll()`      | ✅⁵    |
| `except` / `exceptAll`                      | `.except()` / `.exceptAll()`            | ✅⁵    |
| `.$dynamic()`                               | —                                       | ❌     |
| subquery as derived table / scalar subquery | `.as(alias)` + scalar embed             | ✅⁷    |
| `inArray(col, subquery)`                    | same                                    | ✅⁷    |
| `.for("update" \| "share")` (locking)       | `.for(...)` + `skipLocked`/`noWait`     | ✅⁷    |
| `db.$count(table, where?)`                  | same                                    | ✅⁷    |
| `.distinctOn(...)` (Postgres)               | `.distinctOn(...)`                      | ✅⁷    |
| (no equivalent)                             | `.keyset({ orderBy, after })`           | 🔷⁸    |
| `db.insert(t).values(v)`                    | same                                    | ✅     |
| `.returning(projection?)`                   | same                                    | ✅     |
| `.onConflictDoNothing/DoUpdate`             | same (`on conflict …`)                  | ✅⁴    |
| `db.update(t).set(v).where(...)`            | same                                    | ✅     |
| `sql` in `.set({...})` / `.values({...})`   | `set/values` accept `Sql` values        | ✅     |
| `db.delete(t).where(...)`                   | same                                    | ✅     |
| update/delete without `where`               | allowed (full-table)                    | 🔷     |
| `db.transaction(fn)`                        | same                                    | ✅     |
| `db.batch([...])` (non-interactive)         | `db.batch([...])` — atomic, no callback | ✅     |
| Relational queries `db.query.t.findMany`    | `relations()` + `db.query.t`            | ✅     |

**Divergence (safety):** a `where`-less `update`/`delete` throws in Sisal unless
you call `.unsafeAllowAllRows()`. Drizzle runs it. We consider the rail worth
the friction.

⁴ Upserts emit Postgres/SQLite
`ON CONFLICT (target) DO NOTHING / DO UPDATE SET
… [WHERE …]`. Under the
(adapterless, v0.7-bound) `mysql` dialect the same `onConflict*` calls render
`ON DUPLICATE KEY UPDATE` instead of a separate Drizzle-style
`onDuplicateKeyUpdate` surface, with the typed `excluded(column)` helper
rendering `excluded."col"` there and `values(col)` on MySQL (see the v0.6.0
roadmap C2 for the target/`where` semantics). `target` accepts a column, a
column name, or an array of either.

`.orderBy` accepts both the legacy `(column, "asc" | "desc")` form and one or
more `asc()`/`desc()` terms (or bare columns), e.g.
`orderBy(desc(t.columns.createdAt), asc(t.columns.name))`.

⁵ **CTEs and set operations are fluent in Sisal.** A CTE is created with
`db.$with("name").as(subquery)` (its columns are inferred from the subquery's
projection) and consumed with `db.with(cte).select(...).from(cte)`. A `WITH`
chain may also terminate in a mutation — `db.with(cte).update/insert/delete(t)`
— and a mutation can read another relation via `update(t).from(source)`
(`UPDATE … FROM`), `insert(t).select(query)` (`INSERT … SELECT`), or
`delete(t).using(source)` (`DELETE … USING`, PostgreSQL and MySQL-family; typed
guard on the SQLite family), so one CTE's mutation can consume another's
`RETURNING`. A CTE body may itself be a data-modifying
`INSERT`/`UPDATE`/`DELETE … RETURNING` (PostgreSQL-only). Set operations are
chainable methods on the select builder (`q1.union(q2)`, `.unionAll`,
`.intersect`, `.intersectAll`, `.except`, `.exceptAll`) returning a compound
builder that still accepts `.orderBy`/`.limit`/`.offset` for the whole compound.
Operands are **not** parenthesized, so the same query renders correctly on both
Postgres and SQLite (SQLite rejects parenthesized compound operands). Recursive
CTEs are written with the `` sql`...` `` template.

Relational queries are enabled with `createDatabase({ schema, relations })`.
`db.query` remains callable for raw SQL (``db.query(sql`...`)``) and gains
schema-keyed helpers (`db.query.users.findMany(...)`) when a schema map is
provided.

⁷ **Query-builder ergonomics & subqueries (P7).** `.distinctOn(...)` emits
Postgres `SELECT DISTINCT ON (...)`.
`.for("update" | "share", { skipLocked?,
noWait?, of? })` appends row-level
locking (Postgres/MySQL; SQLite has no locking clause).
`db.$count(table, where?)` runs `select count(*)` and returns a `number`.
`countDistinct(col)` is `count(distinct col)`. A select aliased with `.as("x")`
becomes a derived table usable in `.from(...)`, with its projected columns
referenceable as `x.col`; the same builder embeds as a parenthesized **scalar
subquery** in projections and `where` conditions, and as the right side of
`inArray(col, subquery)` / `notInArray`.

⁸ **Keyset pagination — Sisal leads (divergence by design).** Drizzle has no
first-class keyset/cursor helper; you hand-build the `(a, b, c) < (x, y, z)`
comparison. Sisal's `.keyset({ orderBy, after, form? })` infers the cursor type
from the `orderBy` columns, emits the matching predicate (the default expanded
`or`/`and` form, or a `"row-value"` comparison for a uniform sort direction)
plus the `ORDER BY`, and returns a builder whose `.limit(n).execute()` yields
`{ rows, nextCursor }` (the query probes one row past the page, so a
`nextCursor` comes back only when a next page actually exists). End `orderBy`
with a unique column (e.g. the primary key) so the order is total. For date/time
cursors, prefer DB-returned cursor values and keep a unique final tiebreaker;
PostgreSQL timestamps store microseconds, JS `Date` stores milliseconds, and
Temporal can represent nanoseconds. Asserted by `packages/orm/keyset_test.ts`.

---

## 4. Typed SQL

| Drizzle 0.45.2                     | Sisal                 | Status |
| ---------------------------------- | --------------------- | ------ |
| `` sql`...` ``                     | `` sql`...` ``        | ✅     |
| `sql.raw(s)`                       | `raw(s)`              | ✅     |
| `sql.identifier(s)`                | `identifier(s)`       | ✅     |
| `sql.join(parts, sep)`             | `joinSql(parts, sep)` | ✅     |
| `sql.empty()`                      | `emptySql()`          | ✅     |
| `sql.placeholder(name)`            | `placeholder(name)`   | ✅     |
| prepared statements / `.prepare()` | `.prepare(name?)`     | 🟡     |

Names are namespaced as standalone functions rather than methods on `sql`, but
the capabilities line up.

`placeholder(name)` is a deferred parameter slot usable anywhere a bound value
is (inside the `` sql`...` `` tag or as an operator's right side, e.g.
`eq(users.columns.id, placeholder("id"))`). Every builder
(`select`/`insert`/`update`/`delete` and compound selects) gains
`prepare(name?)`, which returns a `PreparedQuery` you run via `execute(values)`
/ `toSql(values)` with a `{ name: value }` map. Rendering a query that still
holds an **unbound** placeholder is refused, so a forgotten binding fails loudly
instead of becoming `null`. **Divergence (🟡):** because the core is driverless,
`prepare` is a _render-once, bind-many_ statement — it renders the SQL text and
parameter layout a single time and only re-binds values per `execute`, rather
than issuing a driver-level `PREPARE` (the `name` is carried as metadata for a
future server-side prepared path).

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
| `drizzle-kit check` (consistency)   | `sisal drift` (snapshot/checksum drift report)          | 🔷     |
| — (config authored by hand)         | `sisal init` (scaffold config + chosen DB target)       | 🔷     |
| — (no status command)               | `sisal status` (applied vs. pending summary)            | 🔷     |
| `drizzle-kit push`                  | — (out of scope by design)                              | ❌     |
| `drizzle-kit studio`                | — (deferred; possible post-1.0)                         | ❌     |
| journal / snapshot files            | `.snapshot.json` + `readMigrationsDir`                  | 🔷     |
| checksum drift detection            | `checkDrift` + checksum mismatch in `plan()`            | ✅     |
| destructive change handling         | always withheld + returned in `destructive`             | 🔷     |

Sisal additionally offers programmatic migrations, advisory-locked runs, dry
runs, and `down`/`to` rollback — all adapter-neutral.

`drizzle-kit push` (apply the schema straight to the database without a
migration file) is intentionally **out of scope** — Sisal always routes changes
through generated, checksummed migration files. A `studio`-style database GUI is
**deferred**: a possibility to revisit after 1.0, but not on the near-term
roadmap.

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
  `real`, `doublePrecision`, `time`, and `.array()` on the builder.
- Added `.$onUpdate()`, applied automatically in the update builder.
- _Tests:_ `parity: new column types render in DDL via snapshot` and
  `parity: .$onUpdate() injects a value on UPDATE` in the ORM parity test.
- Remaining dedicated-helper gap: `pgEnum` type creation and Drizzle-style
  generated column modifiers. Postgres/Neon DDL for those column shapes is
  reachable via `columns.customType`.

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

### P6 — schema constraints & indexes ✅ done

The schema snapshot already modelled all of these; the gap was the builder API
and the DDL emitters. Both are now closed.

- ✅ **`UNIQUE` and `FOREIGN KEY` constraints** (with `onDelete`/`onUpdate`)
  emit from `generate{Postgres,Sqlite}UpStatements` — Postgres as
  `ALTER … ADD … FOREIGN KEY` after every `CREATE TABLE`, SQLite inline — and
  `.references()` accepts a `{ onDelete?, onUpdate? }` options object.
- ✅ **Table-level extras callback** —
  `defineTable(name, columns, (t) => [...])` returns `primaryKey({ columns })`
  (composite PK), `unique(name?).on(...)` (named/composite unique),
  `index(name?).on(...)` / `uniqueIndex(name?).on(...)` (→ `CREATE INDEX`), and
  `check(name, sql\`…\`)`(inline`CHECK`, columns rendered unqualified for
  portability).
- _Tests:_ `parity: foreign keys + actions emit as ALTER after CREATE`,
  `parity: SQLite emits UNIQUE + inline FOREIGN KEY with actions`, and
  `parity: table extras — composite PK, named unique, check, index(es)` in the
  pg and sqlite parity tests.

### P7 — query-builder ergonomics & subqueries ✅ done

Both the small pure-SQL additions and the larger subquery work landed together.

- ✅ **Row locking** — `.for("update" | "share", { skipLocked?, noWait?, of? })`
  appends `FOR UPDATE` / `FOR SHARE` (with `SKIP LOCKED` / `NOWAIT` / `OF`),
  Postgres/MySQL only.
- ✅ **`db.$count(table, where?)`** runs `select count(*)` and returns a
  `number`; **`.distinctOn(...)`** emits Postgres `SELECT DISTINCT ON (...)`;
  **`countDistinct(col)`** is `count(distinct col)`.
- ✅ **Subqueries** — `select.as("x")` is a derived table for `.from(...)` with
  alias-qualified column refs; the same builder embeds as a parenthesized scalar
  subquery in projections/`where`, and as the operand of
  `inArray(col, subquery)` / `notInArray`.
- _Tests:_ `parity: .distinctOn(...) renders Postgres DISTINCT ON`,
  `parity: .for() row locking …`, `parity: countDistinct(column) aggregate`,
  `parity: subquery as a derived table via .as(alias)`,
  `parity: scalar subquery in projection and where`,
  `parity: inArray(col, subquery) renders IN (select ...)`, and
  `parity: db.$count(table, where?) returns a number` in the ORM parity test.
- Remaining query-builder gap: `.$dynamic()` and window-function helpers (the
  latter already expressible via the `` sql`...` `` template).

### P8 — column-type escape hatch ✅ done

`columns.customType<T>({ kind, dialectType, length?, precision?, scale? })`
exposes the snapshot's existing trusted `dialectType` escape hatch. Postgres DDL
emits `dialectType` verbatim (plus `[]` when `.array()` is used), so `time`,
`interval`, identity syntax, and niche Postgres types (`vector`, `inet`,
geometry, `bit`, `money`) are reachable without one method per type. SQLite
keeps using affinity mapping from `kind` and ignores Postgres-specific
`dialectType`. _Tests:_ `parity: customType exposes dialectType escape hatch` in
the ORM parity test and custom `dialectType` checks in the pg/sqlite parity
tests. Dedicated `pgEnum` type creation and Drizzle-style generated column
modifiers carry over as future convenience/metadata gaps, not Postgres/Neon DDL
reachability gaps.

### P9 — placeholders & prepared statements ✅ done

- ✅ **`placeholder(name)`** — a deferred parameter slot (Drizzle's
  `sql.placeholder`), usable inside the `` sql`...` `` tag and as an operator's
  right side.
- ✅ **`prepare(name?)`** on every builder (`select`/`insert`/`update`/`delete`
  and compound selects) returns a `PreparedQuery` run with `execute(values)` /
  `toSql(values)`. The plan is rendered once and re-bound per call; rendering a
  query with an unbound placeholder is refused.
- 🟡 **Divergence:** driverless, so `prepare` is render-once/bind-many rather
  than a server-side `PREPARE`; the `name` is carried for a future driver path.
- _Tests:_ `parity: placeholder() is a deferred parameter slot` and
  `parity: prepared statement (.prepare/.execute) binds placeholders` in the ORM
  parity test (they replaced the old `roadmap: sql.placeholder …` ledger test).

---

## Keeping this document honest

- When you implement a roadmap item, update its row to ✅/🟡 **and** adjust the
  matching parity test (remove the symbol from the "absent" list or add a
  behavioral assertion).
- When you add a deliberate divergence, add a 🔷 row with its justification.
- The parity tests are the enforcement layer; this document is the explanation.
  They are meant to change together in the same commit.
- Run a periodic **gap sweep**: enumerate Drizzle's surface against the _code_
  (not just this matrix) to catch capabilities that were never tracked at all.
  CTEs, set operations, and the constraint-emission gap were each found this way
  — absent from the document entirely rather than listed as ❌.
