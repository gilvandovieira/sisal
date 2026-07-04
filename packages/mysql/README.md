# @sisal/mysql

MySQL and MariaDB adapter boundaries for [Sisal](https://jsr.io/@sisal/orm).

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

The migration boundary (`@sisal/mysql/migrate`, `@sisal/mysql/ddl`) implements
the DDL design documented in `docs/mysql-ddl-mapping.md`.

## Adapter checklist

| Question            | Answer                                                                                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Driver              | Lazy `npm:mysql2/promise` by default; optional lazy MariaDB Connector/Node.js with `driver: "mariadb"`.                                                                                            |
| Permissions         | `--allow-env` for DSNs, `--allow-net=<host>:<port>` for live connections, and `--allow-read` when loading local config/migrations.                                                                 |
| Migrations          | Yes: `@sisal/mysql/migrate`, MySQL/MariaDB history store, named locks, and `@sisal/mysql/ddl`.                                                                                                     |
| Transactions/batch  | Interactive transactions are supported; `db.batch` runs as one transaction. MySQL/MariaDB DDL itself is not transactional, so migration rollback expectations should stay conservative.            |
| Dialect limitations | MySQL proper has no general `RETURNING`; MariaDB support is version-gated. Partial indexes, expression indexes, generated columns, and functional indexes follow engine capability gates.          |
| Security caveats    | TLS options are explicit and TLS URL params are rejected instead of ignored; DSNs and tokens are redacted; `CLIENT_FOUND_ROWS` ambiguity is disabled; migration SQL is trusted code.               |
| ETL                 | Portable ETL rollups render for MySQL/MariaDB shapes and run where locks/checkpoints/batch support are available; live claims require named MySQL/MariaDB integration scenarios.                   |
| Analytics           | Basic analytics SQL renders for MySQL-family targets where supported; percentiles are PostgreSQL-only and non-PostgreSQL analytics execution is not claimed live without a named integration test. |
