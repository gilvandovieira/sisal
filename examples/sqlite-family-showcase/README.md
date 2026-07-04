# SQLite-family showcase

## What this example teaches

The broad "what Sisal can do today" tour on the SQLite family — and it
**executes end-to-end with no server** (in-memory). It covers:

- `defineTable` with foreign keys, defaults, uniqueness, `$onUpdate`, JSON,
  arrays, and blobs;
- inserts (single, multi-row, `RETURNING`);
- the operator set, ordering + distinct, inner/left joins, aggregates +
  `groupBy` + `having`;
- upserts (`onConflictDoNothing` / `onConflictDoUpdate`), update + delete with
  `RETURNING`;
- transactions (commit **and** rollback);
- raw parameterized SQL via the `sql` tag;
- **relational loading** — `db.query.<table>.findMany({ with: { … } })` with
  nested relations;
- CTEs (`$with(...).as(...)`), set operations (union/intersect/except), and a
  recursive CTE;
- additive/destructive migration diffing.

## Packages used

`@sisal/orm`, `@sisal/sqlite` (+ `@sisal/sqlite/ddl`), `@sisal/libsql`.

## Dialect target

SQLite family. The dialect + builder are shared and `SqliteDatabase` ≡
`LibsqlDatabase`, so the same body runs over embedded `@sisal/sqlite`
(`:memory:`) or `@sisal/libsql`/Turso — pick with `SISAL_ADAPTER`.

## What is portable

The builder surface, relations, CTEs, set operations, transactions, and
migration diffing are the shared Sisal API.

## What is dialect-specific

SQLite has no native `ILIKE` (it renders as case-insensitive `LIKE`);
`json`/`jsonb` and arrays auto-serialize to TEXT and read back as strings;
booleans round-trip as `0`/`1`; recursive CTEs use the `sql` template. These are
called out inline in the code.

## How to run

```sh
# embedded @sisal/sqlite, in-memory (zero setup):
deno task run

# over @sisal/libsql (local file / Turso):
SISAL_ADAPTER=libsql deno task run
```

Environment variables:

```
TURSO_DATABASE_URL=   # optional; libsql/Turso endpoint
TURSO_AUTH_TOKEN=     # optional; Turso auth token
```

`deno task run` uses `-A` because `@db/sqlite` loads a native library (FFI).

## Expected output

Sectioned, executed output for every feature above — generated DDL, insert
results, operator/join/aggregate results, upsert effects, transaction
commit/rollback proofs, relational graphs, CTE/set-operation results, and the
withheld destructive migration changes.

## Sisal API pressure points

Honest gaps this example ran into, kept distinct from the SQLite-family dialect
limits Sisal handles for you. The SQLite divergences below are authoritative per
the "SQLite-family divergences" bullet in `CLAUDE.md`.

1. **Recursive CTEs have no builder — they fall back to the raw `sql`
   template.** _API gap._ Non-recursive CTEs are builder-native
   (`db.$with("adults").as(...)`, `mod.ts:358`), but the self-referencing
   `with recursive seq(x) as (...)` is hand-written through the `sql` tag
   (`mod.ts:386`–`mod.ts:392`). A `$withRecursive` surface is the primitive
   Sisal could add to close it.
2. **`ILIKE` has no SQLite equivalent — Sisal transparently renders a
   case-insensitive `LIKE`.** _Driver/engine limitation (correctly NOT a Sisal
   gap)._ `ilike(users.columns.email, "A%")` executes with no user-side
   workaround (`mod.ts:211`–`mod.ts:216`); the degradation is inside the dialect
   renderer.
3. **JSON/arrays serialize to TEXT and read back as strings; booleans round-trip
   as `0`/`1`.** _Driver/engine limitation (correctly NOT a Sisal gap)._ The
   `documents` table stores `jsonb`, `text[]`, and `bytea` (`mod.ts:99`,
   `mod.ts:102`) and writes them straight through the builder (`mod.ts:180`–
   `mod.ts:186`); the app parses on read. This is inherent to SQLite storage
   classes, not a missing Sisal primitive.
4. **The raw-`sql` count is a deliberate escape-hatch demo, not a gap.**
   _Notably NOT a pressure point._ The `select count(*) as n from users ...` raw
   query (`mod.ts:322`–`mod.ts:326`) shows the parameterized `sql` tag; the same
   count is available builder-native via the `count()` aggregate used two
   sections earlier (`mod.ts:256`–`mod.ts:268`).

## Notes

Columns are nullable by default; `.notNull()` opts out. A plain nullable column
is still required on insert unless `.optional()` or `.default()`.
