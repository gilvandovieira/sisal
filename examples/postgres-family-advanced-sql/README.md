# PostgreSQL-family advanced SQL

## What this example teaches

That Sisal is a serious SQL builder, not just CRUD. It graduates the
[advanced-SQL contracts](../advanced-sql-contracts/README.md) into a runnable
workspace example for `@sisal/pg` / `@sisal/neon`, using **Sisal builders where
they exist** and a safe parameterized `sql` template only for the residual
shapes the public API doesn't yet cover.

Cases (see `src/statements.ts`): ETL rollup, window analytics, sessionization,
top-N per group, cohort retention, funnel analysis, recursive comments,
job-queue locking, idempotent backfill, JSON-table extraction, and generated
columns + expression/partial indexes.

## Packages used

`@sisal/orm`, `@sisal/pg` (+ `@sisal/pg/ddl`), `@sisal/neon`.

## Dialect target

PostgreSQL family — the richest advanced-SQL surface. `SISAL_ADAPTER` accepts
`pg`, `pg-db-postgres`, or `neon`.

## What is portable

The window functions (`over`/`rank`/`rowNumber`/`lag`), recursive CTEs
(`$withRecursive`), `filter(...)` aggregates, `jsonTable(...)`,
`insert().select()` rollups, and `FOR UPDATE SKIP LOCKED` locking are all
builder-native and render on every engine that supports the shape.

## What is dialect-specific

Postgres-native shapes shown here — `jsonb_to_recordset`, partial/expression
indexes, `date_trunc` intervals — differ or narrow on other engines; see the
MySQL and SQLite advanced-SQL siblings and
[`docs/feature-matrix.md`](../../docs/feature-matrix.md).

## How to run

```sh
# render every case to SQL (no database):
deno task render

# execute against a scratch database (rolled back):
DATABASE_URL=postgres://postgres:postgres@localhost:5432/scratch \
  SISAL_ADAPTER=pg deno task run

# golden-SQL render tests:
deno task test

# live integration (opt-in):
SISAL_POSTGRES_ADVANCED_SQL_IT=1 \
  DATABASE_URL=postgres://postgres:postgres@localhost:5432/scratch \
  deno task test:db
```

## Expected output

Each case's label and rendered, parameterized Postgres SQL. With `DATABASE_URL`,
the `run` task also executes the executable cases inside a transaction it rolls
back.

## Sisal API pressure points

Honest gaps this example surfaced, grounded in `src/statements.ts` and mapped to
the [contracts triage](../advanced-sql-contracts/README.md#triage-v0110). This
example is built to find the ORM's limits on the richest dialect.

1. **Filtered-metric arithmetic has no expression alias.** _API gap._ The
   rollup's `engagement_score` re-states both `filter(count())` metrics inside a
   raw arithmetic `sql` expression (`src/statements.ts:237-239`) because there
   is no way to alias a filtered metric and reuse it, nor an arithmetic
   combinator over aggregates. `filter(...)` itself is builder-native. Maps to
   contract 01 (also etl-native via
   [`@sisal/etl`](../postgres-family-etl-cron/)).
2. **No interval/duration threshold type for the session gap.** _API gap._ The
   30-minute boundary stays an inline
   `${occurred_at} - ${previous_at} > '30 minutes'::interval` fragment
   (`src/statements.ts:297-302`); `dateDiff()` truncates to whole units and
   would shift the 30–31-minute boundary, so it cannot drive the test. The
   `lag()` and `sum() OVER` windows around it are builder-native. Maps to
   contract 03.
3. **The builder joins tables, not CTEs.** _API gap._ Cohort retention
   hand-writes the CTE-to-CTE `FROM ... INNER JOIN` as an `identifier()`
   fragment (`src/statements.ts:355-357`); `$with()`, `dateTrunc()`, `min()`,
   and `countDistinct()` around it are builder-native. Maps to contract 05.
4. **No interval arithmetic in a builder expression.** _API gap._ The funnel's
   "within one day" deadline (`voted_at <= viewed_at + '1 day'::interval`)
   forces its two `count(*) FILTER (...)` steps back into raw `sql`
   (`src/statements.ts:378-385`). The period-over-period part of this contract
   is analytics-native (`@sisal/analytics` `compareToPreviousWindow`). Maps to
   contract 06.
5. **No scalar string/cast/arithmetic expression builders.** _API gap._ The
   recursive walk's depth and materialized `path` stay inline `sql` (`0`,
   `${self.depth} + 1`, `lpad(${c.id}::text, ...)`, `|| '.' ||`) at
   `src/statements.ts:403,410-411`; `$withRecursive()` supplies the UNION ALL,
   self-reference, and depth guard around them. Maps to contract 07.
6. **No builder join to a set-returning function.** _API gap._ `jsonTable()` is
   builder-native (renders `jsonb_to_recordset` with a typed column list), but
   the base-table-to-function LATERAL cross-join is an inline
   `from(sql`${identifier(...)}, ${items.from}`)` fragment
   (`src/statements.ts:461`). Maps to contract 10.
7. **No portable claim / advisory-lock abstraction.** _API gap._ The queue claim
   is fully builder-native here (`.for("update", { skipLocked: true })`,
   `src/statements.ts:425-434`), but there is no engine-portable "claim one job"
   or advisory-lock primitive — the SQLite sibling has to fall back to a CAS
   `UPDATE ... RETURNING`. Maps to contract 08.

**Not pain points (resolved):** generated column + partial expression index are
builder-native via the schema snapshot — `documents` carries
`.generatedAs(sql`payload ->> 'title'`, { stored: true })` and a partial
expression `index(...).where(...).on(...)` (`src/schema.ts:70-77`), emitted by
`generatePostgresUpStatements` (`src/statements.ts:466-478`); the only residual
is that it renders as DDL from a snapshot, not a query builder (contract 11).
The idempotent-backfill checkpoint is a raw upsert here
(`src/statements.ts:438-445`) but is now etl-native (contract 09). Window
analytics (contract 02) is fully builder-native and additionally
analytics-native (`@sisal/analytics` `movingAvg`/`rank`).

## Notes

Most cases are **builder-native** today; a few carry a documented residual `sql`
fragment (e.g. an interval threshold or a CTE-to-CTE `FROM`). Contracts 01 and
09 (ETL) are now better served by [`@sisal/etl`](../postgres-family-etl-cron/),
and 02 (windows) by [`@sisal/analytics`](../postgres-family-analytics/) — this
example keeps the hand-built SQL forms for comparison. See the
[contracts triage](../advanced-sql-contracts/README.md#triage-v0110).
