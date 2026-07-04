# SQLite-family advanced SQL

Runnable conservative advanced SQL examples for embedded SQLite and libSQL.

SQLite coverage is intentionally narrower than PostgreSQL and MySQL. The example
probes capabilities and runs each case only when its feature is supported,
printing a skip line otherwise: ETL rollup, window analytics, sessionization,
top-N per group, cohort retention, funnel analysis, recursive CTEs, a
compare-and-set queue claim, JSON extraction through `json_each`, and generated
columns/partial indexes where supported.

## Commands

```sh
deno task render

SISAL_SQLITE_ADVANCED_SQL_IT=1 deno task run

SISAL_SQLITE_ADVANCED_SQL_IT=1 deno task test:db

SISAL_ADAPTER=libsql SISAL_LIBSQL_URL=file:./sisal-advanced-sql.sqlite \
  SISAL_SQLITE_ADVANCED_SQL_IT=1 deno task run
```

The live path probes support before running optional features and prints a skip
line for missing capabilities.

## Coverage

- Builder-native (capability-probed): ETL rollup, window analytics
  (`over`/`rank`), sessionization, top-N (`over(rowNumber)`), cohort retention,
  funnel analysis, recursive CTEs (`$withRecursive`), and JSON extraction
  (`jsonTable(...)` → `json_each`). Some cases keep a documented residual inline
  `sql` fragment.
- Raw / DDL: the CAS `UPDATE … RETURNING` queue claim (SQLite has no row locks)
  and hand-written generated-column + partial-index DDL.
- Skipped first pass: **idempotent backfill only** (checkpoint semantics) — it
  is `@sisal/etl`'s job; see
  [`postgres-family-etl-cron`](../postgres-family-etl-cron/). MySQL
  compatibility is not applicable to this family.

See the [contracts triage](../advanced-sql-contracts/README.md#triage-v0110).

## Sisal API pressure points

Honest gaps this example surfaced, grounded in `src/statements.ts` and mapped to
the [contracts triage](../advanced-sql-contracts/README.md#triage-v0110). Some
overlap the Postgres sibling; SQLite adds its own dialect-shaped ones.

1. **Filtered-metric arithmetic has no expression alias.** _API gap._ Same as
   the Postgres sibling: `engagement_score` re-states the two `filter(count())`
   metrics in a raw arithmetic `sql` (`src/statements.ts:245-247`). `filter()`
   is builder-native (SQLite has native `FILTER`). Maps to contract 01.
2. **No CASE / boolean-flag builder for the session-start flag.** _API gap._
   Here `dateDiff("minutes", ...)` is builder-native (renders `julianday` math),
   but the `case when ... > 30 then 1 else 0 end` wrapper stays inline
   (`src/statements.ts:305-307`). Maps to contract 03.
3. **Day-bucketing and the CTE-to-CTE join are raw.** _API gap._ Cohort
   retention uses inline `date(${min(...)})` / `date(${occurred_at})` for day
   buckets (`src/statements.ts:348,354`) and an
   `identifier("first_seen") inner join identifier("activity")` FROM fragment
   (`src/statements.ts:362-364`); `countDistinct()` and the `$with()` CTEs are
   builder-native. Maps to contract 05.
4. **No interval arithmetic in a builder expression.** _API gap._ The funnel's
   "+1 day" deadline is an inline `datetime(${viewed_at}, '+1 day')` fragment
   (`src/statements.ts:387`); the `filter(count())` / `filter(min())` pivots are
   builder-native. Maps to contract 06.
5. **No scalar string/format expression builders.** _API gap._ The recursive
   `path` materialization (`printf('%08d', ${c.id})`, `|| '.' ||`,
   `${self.depth} + 1`) stays inline (`src/statements.ts:413,420-421`) — SQLite
   has no builder equivalent; `$withRecursive()` and the depth guard are
   builder-native. Maps to contract 07.
6. **No row locks — the queue claim is a raw CAS.** _Driver/engine limitation_
   (with an API-gap residual). SQLite has no `FOR UPDATE SKIP LOCKED`, so the
   claim is a hand-written
   `UPDATE ... WHERE id = (SELECT ... LIMIT 1) AND status = 'pending' RETURNING`
   (`src/statements.ts:435-452`). Even that CAS shape (an update with a
   subquery-`WHERE` plus `RETURNING`) has no builder surface. Maps to contract
   08.
7. **No builder join to a set-returning function.** _API gap._ `jsonTable()`
   compiles to `json_each` + per-field `json_extract` (builder-native), but the
   base-table-to-function comma/lateral FROM is inline
   (`src/statements.ts:467`). Maps to contract 10.

**Not pain points (resolved / genuinely dialect-gated):** generated column +
partial index are snapshot-emittable on SQLite; this case deliberately keeps
literal `CREATE TABLE ... GENERATED ALWAYS AS ... STORED` + partial
`CREATE INDEX ... WHERE` (`src/statements.ts:472-488`) to show the shape
verbatim (contract 11). Idempotent backfill (contract 09) is skipped here
(`implementation: "skipped"`, `src/statements.ts:174-179`) — checkpointing is
`@sisal/etl`'s job. Window analytics (02), top-N (04), recursive comments (07),
and JSON-table (10) carry a `requires` capability probe because older SQLite
builds lack window functions or `json_each` — a genuine engine gate, not a
builder gap.
