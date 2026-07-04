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
