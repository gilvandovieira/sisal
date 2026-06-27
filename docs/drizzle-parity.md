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

| Drizzle (`pg-core`)           | Sisal                                           | Status |
| ----------------------------- | ----------------------------------------------- | ------ |
| `text`                        | `columns.text()`                                | ✅     |
| `varchar({ length })`         | `columns.varchar(n)`                            | ✅     |
| `integer`                     | `columns.integer()`                             | ✅     |
| `bigint({ mode })`            | `columns.bigint()` (string-typed)               | 🟡     |
| `boolean`                     | `columns.boolean()`                             | ✅     |
| `timestamp({ withTimezone })` | `columns.timestamp({ withTimezone })`           | ✅     |
| `date`                        | `columns.date()`                                | ✅     |
| `uuid`                        | `columns.uuid()`                                | ✅     |
| `json` / `jsonb`              | `columns.json<T>()` / `columns.jsonb<T>()`      | ✅     |
| `serial` / `bigserial`        | —                                               | ❌     |
| `real` / `doublePrecision`    | `columns.number()` (generic)                    | 🟡     |
| `numeric` / `decimal`         | —                                               | ❌     |
| `char`                        | —                                               | ❌     |
| `smallint`                    | —                                               | ❌     |
| `*.array()`                   | — (snapshot supports `array`, builder does not) | ❌     |
| custom `pgEnum`               | —                                               | ❌     |

The DDL layer already understands more `kind`s than the builder exposes
(`numeric`, `char`, `smallint`, `serial`, `real`, arrays, …), so most of these
are "surface the builder," not "design from scratch."

### Column modifiers

| Drizzle 0.45.2                  | Sisal                                       | Status |
| ------------------------------- | ------------------------------------------- | ------ |
| `.notNull()`                    | `.notNull()`                                | ✅     |
| `.default(v)`                   | `.default(v \| () => v)`                    | ✅     |
| `.$default()` / `.$defaultFn()` | `.default(() => v)` covers both             | 🟡     |
| `.primaryKey()`                 | `.primaryKey()`                             | ✅     |
| `.unique()`                     | `.unique()`                                 | ✅     |
| `.references(() => t.col)`      | `.references("table", "column")`            | 🔷     |
| `.$type<T>()`                   | type param on factory (`columns.json<T>()`) | 🔷     |
| `.array()`                      | —                                           | ❌     |
| `.$onUpdate(fn)`                | —                                           | ❌     |
| `.generatedAlwaysAs(...)`       | —                                           | ❌     |
| (no equivalent)                 | `.nullable()`                               | 🔷     |
| (no equivalent)                 | `.optional()` (insert-optional)             | 🔷     |
| (no equivalent)                 | `.named(name)`                              | 🔷     |

### ⚠️ Behavioral divergence: nullability default

> **Drizzle (and SQL) columns are nullable by default; Sisal columns are
> `NOT NULL` by default.**

In Sisal you must opt **into** nullability with `.nullable()`. Also note that
`.optional()` only makes a field optional **on insert** — it does **not** make
the column nullable. So `columns.text().optional()` still generates a `NOT NULL`
column. This is the single biggest footgun for someone arriving from Drizzle,
and it is asserted explicitly in the parity tests. **Decision needed** (see
roadmap P0): keep-and-document, or flip to nullable-by-default for true parity.

---

## 2. Filter operators

| Drizzle 0.45.2                                     | Sisal                           | Status |
| -------------------------------------------------- | ------------------------------- | ------ |
| `eq`, `ne`                                         | `eq`, `ne`                      | ✅     |
| `gt`, `gte`, `lt`, `lte`                           | same                            | ✅     |
| `like`, `ilike`                                    | `like`, `ilike`                 | ✅     |
| `inArray`, `notInArray`                            | same                            | ✅¹    |
| `isNull`, `isNotNull`                              | same                            | ✅     |
| `and`, `or`, `not`                                 | same                            | ✅²    |
| `between`, `notBetween`                            | —                               | ❌     |
| `notLike`, `notIlike`                              | —                               | ❌     |
| `exists`, `notExists`                              | —                               | ❌     |
| `arrayContains`, `arrayContained`, `arrayOverlaps` | —                               | ❌     |
| `asc`, `desc` (order helpers)                      | `orderBy(col, "asc" \| "desc")` | 🔷     |
| `count`, `sum`, `avg`, `min`, `max`                | —                               | ❌     |

¹ **Divergence:** Drizzle throws on an empty `inArray`; Sisal returns a constant
condition (`1 = 0` / `1 = 1`) so dynamic filters with no values are safe.

² **Divergence:** Sisal's `and`/`or` silently ignore `null`/`undefined`
arguments, so conditional filters need no pre-filtering.

**Output divergence:** Sisal always renders column references **table-qualified
and parameterized** (`"users"."id" = $1`), where Drizzle may emit a bare
`"id" = 42`. Behavior is equivalent; the text differs.

---

## 3. Query builder

| Drizzle 0.45.2                           | Sisal                          | Status |
| ---------------------------------------- | ------------------------------ | ------ |
| `db.select().from(t)`                    | same                           | ✅     |
| `db.select({ projection })`              | same                           | ✅     |
| `.where(...)`                            | same                           | ✅     |
| `.orderBy(asc(c), desc(c))`              | `.orderBy(c, "asc" \| "desc")` | 🟡     |
| `.limit(n)` / `.offset(n)`               | same                           | ✅     |
| `.innerJoin` / `.leftJoin`               | same                           | ✅     |
| `.rightJoin` / `.fullJoin`               | —                              | ❌     |
| `.groupBy(...)` / `.having(...)`         | —                              | ❌     |
| `.$dynamic()` / `.distinct()`            | —                              | ❌     |
| `db.insert(t).values(v)`                 | same                           | ✅     |
| `.returning(projection?)`                | same                           | ✅     |
| `.onConflictDoNothing/DoUpdate`          | —                              | ❌     |
| `db.update(t).set(v).where(...)`         | same                           | ✅     |
| `db.delete(t).where(...)`                | same                           | ✅     |
| update/delete without `where`            | allowed (full-table)           | 🔷     |
| `db.transaction(fn)`                     | same                           | ✅     |
| Relational queries `db.query.t.findMany` | —                              | ❌     |

**Divergence (safety):** a `where`-less `update`/`delete` throws in Sisal unless
you call `.unsafeAllowAllRows()`. Drizzle runs it. We consider the rail worth
the friction.

`.orderBy` is 🟡 because it is single-column with a direction argument rather
than accepting `asc()/desc()` expressions and multiple keys.

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
| `drizzle-kit generate`              | `generate*UpStatements` + `buildMigrationFile` (no CLI) | 🟡     |
| `drizzle-kit push`                  | —                                                       | ❌     |
| `drizzle-kit studio`                | —                                                       | ❌     |
| journal / snapshot files            | `.snapshot.json` + `readMigrationsDir`                  | 🔷     |
| checksum drift detection            | `checkDrift` + checksum mismatch in `plan()`            | ✅     |
| destructive change handling         | always withheld + returned in `destructive`             | 🔷     |

Sisal additionally offers programmatic migrations, advisory-locked runs, dry
runs, and `down`/`to` rollback — all adapter-neutral.

---

## 6. Adapters / connection

| Drizzle 0.45.2                         | Sisal                                                  | Status |
| -------------------------------------- | ------------------------------------------------------ | ------ |
| `drizzle(client)` (per driver package) | `createPgDb` / `connect`, `createSqliteDb` / `connect` | 🔷     |
| `node-postgres` / `postgres-js` / etc. | `@db/postgres`-compatible client                       | 🟡     |
| `better-sqlite3` / `libsql` / `d1`     | `@db/sqlite` (lazy)                                    | 🟡     |
| `mysql2`                               | — (snapshot/dialect aware, no adapter)                 | ❌     |

---

## Roadmap

Ordered by leverage. Each item names the parity test(s) that will flip when it
lands.

### P0 — decide the nullability default

The `NOT NULL`-by-default behavior is the highest-impact divergence. Either:

- **(a)** keep it and document loudly (current state), or
- **(b)** flip columns to nullable-by-default and require `.notNull()` like
  Drizzle/SQL.

Until decided, the divergence is pinned by
`divergence: columns are NOT NULL by default` in the ORM parity test.

### P1 — operator & ordering parity (cheap, high value)

- Add `between`, `notBetween`, `notLike`, `notIlike`.
- Add `asc(col)` / `desc(col)` and let `orderBy` take multiple expressions.
- Add aggregate helpers `count`, `sum`, `avg`, `min`, `max`.
- _Tests:_ `roadmap: Drizzle operators not yet implemented are absent`.

### P2 — query builder breadth

- `onConflictDoNothing` / `onConflictDoUpdate` (upserts).
- `groupBy` / `having`, `distinct`.
- `rightJoin` / `fullJoin`.
- _Tests:_ `parity: join methods present; advanced builder methods are gaps`.

### P3 — column surface

- Expose `numeric`/`decimal`, `char`, `smallint`, `serial`, `real` and
  `.array()` on the builder (the snapshot + DDL already model them).
- Add `.$onUpdate()`.

### P4 — relational queries

- `relations()` + `db.query.table.findMany/findFirst` with `with`/`columns`.
  This is the largest single feature and should come after the builder is broad.

### P5 — tooling

- A `sisal` CLI over the existing workflow helpers: `generate` (diff snapshot →
  migration), `migrate`, `status`/`drift`. `push` and a studio-like inspector
  are stretch goals.

---

## Keeping this document honest

- When you implement a roadmap item, update its row to ✅/🟡 **and** adjust the
  matching parity test (remove the symbol from the "absent" list or add a
  behavioral assertion).
- When you add a deliberate divergence, add a 🔷 row with its justification.
- The parity tests are the enforcement layer; this document is the explanation.
  They are meant to change together in the same commit.
