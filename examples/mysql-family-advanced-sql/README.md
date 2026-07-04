# MySQL-family advanced SQL

Runnable advanced SQL examples for `@sisal/mysql` on MySQL 8 and MariaDB.

The example uses builders where Sisal already has a portable surface and the
safe `sql` template for engine-supported SQL whose builder primitive does not
exist yet. MySQL-only limits, especially `RETURNING` and partial indexes, are
kept explicit instead of being hidden behind weak emulation.

## Commands

```sh
deno task render

MYSQL_URL=mysql://root:root@localhost:33084/sisal \
  SISAL_ADAPTER=mysql2 deno task run

SISAL_MYSQL_ADVANCED_SQL_IT=1 \
  MYSQL_URL=mysql://root:root@localhost:33084/sisal \
  deno task test:db

SISAL_MARIADB_ADVANCED_SQL_IT=1 \
  MARIADB_URL=mysql://root:root@localhost:33110/sisal \
  SISAL_ADAPTER=mariadb deno task test:db
```

MySQL and MariaDB DDL implicitly commits, so the live run creates namespaced
`sisal_adv_*` tables and drops them in cleanup.

## Coverage

- Builder-native: ETL rollup (`insert().select()` + `filter` → `CASE`), window
  analytics (`over`/`rank`), sessionization, top-N (`over(rowNumber)`), cohorts,
  funnels, recursive CTEs (`$withRecursive`), `jsonTable(...)` → `JSON_TABLE`,
  row locking (`.for("update", { skipLocked })`), and ODKU upsert rendering.
  Some cases keep a documented residual inline `sql` fragment (interval math, a
  CTE-to-CTE join).
- Guarded/documented: base MySQL `RETURNING` (a typed `OrmError`), partial
  indexes (no MySQL equivalent), generated-column DDL, and older
  windowless/recursive-less server versions.

See the [contracts triage](../advanced-sql-contracts/README.md#triage-v0110):
contract 01 is now best served by `@sisal/etl` and 02 by `@sisal/analytics`;
this example keeps the hand-built forms for comparison.

## Sisal API pressure points

Honest gaps this example surfaced, grounded in `src/statements.ts` and mapped to
the [contracts triage](../advanced-sql-contracts/README.md#triage-v0110).
MySQL's gaps are dialect-shaped and differ from the Postgres/SQLite siblings —
several are genuine driver/engine limits, not missing builder surface.

1. **`FILTER` is rebuilt as `CASE`; the metric arithmetic is still raw.**
   _Driver/engine limitation + API gap._ MySQL has no `FILTER`, so
   `filter(count())` renders automatically as `sum(case when ...)`
   (builder-native rebuild); but the rollup's `engagement_score` still re-states
   both metrics in a raw arithmetic `sql` (`src/statements.ts:242-244`) for lack
   of an expression alias. Maps to contract 01.
2. **No `ORDER BY` alias reuse (MySQL restriction).** _Driver/engine
   limitation._ MySQL forbids referencing a SELECT alias in `ORDER BY`, so the
   rank window is defined once and repeated in both the projection and the
   `ORDER BY` (`src/statements.ts:263-279`). Window functions themselves are
   builder-native but require MySQL 8 / a recent MariaDB — older servers have
   none (`❌`). Maps to contracts 02 and 04.
3. **No CASE builder for the session-start flag.** _API gap._
   `dateDiff("minutes", ...)` renders `TIMESTAMPDIFF` (builder-native), but the
   boundary `case when ... > 30 ... end` stays inline
   (`src/statements.ts:301-303`). Maps to contract 03.
4. **`dateTrunc` day-bucketing is avoided.** _API gap / driver limitation._
   MySQL `dateTrunc` returns text, so cohort day buckets are inline `date(...)`
   fragments (`src/statements.ts:343,346`). Notably the CTE-to-CTE join the
   Postgres/SQLite siblings hand-write is refactored away here into a
   builder-native `innerJoin(events, ...)` (`src/statements.ts:351-355`). Maps
   to contract 05.
5. **No `FILTER` and no interval-add — the funnel outer metrics are fully raw.**
   _Driver/engine limitation + API gap._ With no MySQL `FILTER` and a
   `timestampadd(day, 1, viewed_at)` deadline, all three outer funnel counts are
   raw `sum(case when ...)` (`src/statements.ts:374-379`); the first-event
   pivots (`filter(min())`) do rebuild natively as `min(case when ...)`
   (`src/statements.ts:363-369`). Maps to contract 06.
6. **No scalar cast/`lpad`/`concat` expression builders.** _API gap._ The
   recursive depth/path expressions stay inline
   (`cast(lpad(cast(${c.id} as char), 8, '0') as char(512))`, `concat(...)`,
   `${self.depth} + 1`) at `src/statements.ts:399,407-408`; `$withRecursive()`
   and the self-reference guard are builder-native (require MySQL 8 / recent
   MariaDB). Maps to contract 07.
7. **`jsonTable()` renders `JSON_TABLE`, but the base table is referenced raw.**
   _API gap._ The documents table has no `defineTable` in this demo, so
   `jsonTable(sql`d.payload`, ...)`, the `from(sql`... d join ${item.from}`)`,
   and `sql`d.id`` are inline (`src/statements.ts:449-459`). The typed `COLUMNS`
   projection is builder-native. Maps to contract 10.
8. **MySQL has no partial index — generated-column DDL is hand-written.**
   _Driver/engine limitation._ `.generatedAs()` ships and the snapshot generator
   fails closed on partial indexes for MySQL (`❌`), so this plain
   stored-column-plus-index `CREATE TABLE` is hand-written outside the snapshot
   flow (`src/statements.ts:462-474`). Maps to contract 11.
9. **Base MySQL has no `RETURNING` — it is a guarded `OrmError`.**
   _Driver/engine limitation._ `returningGuard` calls `.returning()` and renders
   to a typed `OrmError` on base MySQL (`src/statements.ts:490-499`, caught at
   `src/statements.ts:211-218`); MariaDB / detected identity lights
   `INSERT ... RETURNING`. The ODKU `upsertPressure` also needs a raw `sql`
   increment for `hot_score + 1` — no arithmetic-assignment helper
   (`src/statements.ts:476-488`). Maps to contract 12.

**Not pain points (resolved):** row locking (contract 08) is builder-native
(`.for("update", { skipLocked: true })`, `src/statements.ts:422-432`). The
idempotent-backfill checkpoint is a raw `ON DUPLICATE KEY UPDATE` upsert
(`src/statements.ts:434-443`) but is now etl-native (contract 09). Window
analytics (contract 02) is additionally analytics-native (`@sisal/analytics`
`movingAvg`/`rank`).
