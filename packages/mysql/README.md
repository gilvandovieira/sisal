# @sisal/mysql

MySQL and MariaDB adapter boundaries for [Sisal](https://jsr.io/@sisal/orm) —
the fifth Sisal dialect, built from the v0.6 readiness investigation
(`docs/mysql-readiness.md`).

**One adapter, both engines:** MySQL ≥ 8.0.16 is the baseline; MariaDB ≥ 10.10
runs on the same adapter. Variant-gated capabilities (e.g. MariaDB
`INSERT … RETURNING`) light up through the `(engine, variant, version)` dialect
identity, which `connect` fills automatically from `select version()`
(`detectVersion: false` opts out for a fully lazy connect; explicit
`variant`/`version` also skip detection).

```ts
import { connect } from "@sisal/mysql";

const db = await connect({
  url: "mysql://user:password@localhost:3306/app",
  // driver: "mariadb",  // opt-in: the MariaDB Connector/Node.js (see below)
});
```

The default driver is `mysql2/promise`, imported lazily, with
`supportBigNumbers` + `bigNumberStrings` always set (mysql2's default `BIGINT`
decode silently truncates past 2⁵³; see `perf/MYSQL_DRIVER_SURVEY.md`).
`connect({ driver: "mariadb" })` opts into the MariaDB Connector/Node.js — the
fastest driver in the C6 benchmarks — resolved through a runtime-computed
specifier so the LGPL connector stays a soft, run-time-only dependency (the
postgres.js pattern). Statements run through the text protocol (`query()`)
because MySQL 8's binary protocol rejects a bound `LIMIT ?`; `BLOB` values are
re-viewed as plain `Uint8Array`s; `BOOLEAN` (`TINYINT(1)`) round-trips as
`0`/`1` like the SQLite family. The SQL executor is injectable
(`connect({ executor })`), so unit tests stay network-free — the same seam every
Sisal adapter uses.

The migration boundary (`@sisal/mysql/migrate`, `@sisal/mysql/ddl`) ships with
the v0.7 B5/B6 roadmap tasks; the DDL design it implements is
`docs/mysql-ddl-mapping.md`.
