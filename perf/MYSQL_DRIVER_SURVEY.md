# MySQL driver survey — the C6 report (v0.6.0 workstream C)

**Date:** 2026-07-01 · **Probe:**
[`perf/mysql_driver_survey.ts`](./mysql_driver_survey.ts) · **Runtimes:** Deno
2.9.0 (benchmarks) + Node v26.4.0 (dual-runtime check) · **Servers:** MySQL
**8.4.10** and MariaDB **11.8.8** (Docker, localhost)

The v0.7 `@sisal/mysql` adapter needs a driver that (a) runs on **Deno and
Node** — the npm-readiness door-open constraint, (b) authenticates against MySQL
8's default `caching_sha2_password`, (c) pools and prepares, and (d) — the
v0.5.1 lesson — does not stall on parameterized round trips (`jsr:@db/postgres`
lost ~40 ms/query to Nagle × delayed-ACK; see
[`PG_ADAPTER_PERF_REPORT.md`](./PG_ADAPTER_PERF_REPORT.md)). Sequential
per-query latency is therefore the discriminating metric, measured with the same
harness (`latency.ts`, 300 timed iters after 30 warm-ups, one query in flight at
a time).

## Recommendation

**Default driver for `@sisal/mysql`: `npm:mysql2` — with
`supportBigNumbers: true, bigNumberStrings: true` set by the executor
(non-negotiable: the driver's default `BIGINT` decode is silently lossy).**
Rationale: MIT-licensed, the de-facto standard with the largest ecosystem,
verified working on Deno **and** Node against MySQL 8.4 and MariaDB 11, true
prepared statements with a statement cache, pooling, TLS, and no Nagle-class
stall (p50 ≈ 0.08 ms parameterized — ~500× under the failure mode this survey
exists to rule out).

**`npm:mariadb` (MariaDB Connector/Node.js) is the performance opt-in
candidate** — fastest on every path in both benches (~1.5–2× lower sequential
p50, ~24.5k vs ~20k pooled qps) and precision-correct by default (`BIGINT` →
`BigInt`). It is **LGPL-2.1-or-later**, which is why it is the opt-in rather
than the default dependency of a permissively-licensed toolkit. The adapter's
injectable-executor seam (the same one that carried postgres.js into
`@sisal/pg`) makes this a `connect({ driver: "mariadb" })`-style lazy import,
exactly like `@sisal/pg`'s postgres.js opt-in.

**Watch:** `jsr:@db/mysql` (denodrivers v3) — the pure-JSR aesthetic match for
`@db/postgres`, and it works (auths against MySQL 8.4, decodes `BIGINT` →
`BigInt`, competitive latency) — but it has **no stable release** (`3.0.0-rc.1`,
`latest: null`) and is **Deno-only**, which breaks the npm door-open constraint.
Revisit if v3 ships stable. The `@db/postgres` experience is also a caution
against defaulting to the pure-JSR driver on aesthetics.

**Serverless:** `npm:@planetscale/database` (Apache-2.0) is a fetch/HTTP driver
bound to PlanetScale's service — nothing to benchmark locally. It is the MySQL
analogue of `@sisal/neon`: a **future adapter variant**, not a base driver.

## Sequential latency (Deno 2.9.0, one query in flight)

Against **MySQL 8.4.10**:

```
path                                 n   min   p50   p90   p99  mean  vs fastest
--------------------------------------------------------------------------------
mariadb query() text protocol      300  0.03  0.04  0.07  0.29  0.05        1.0×
mariadb execute() prepared         300  0.03  0.05  0.11  0.20  0.06        1.1×
mariadb query() inline literals    300  0.03  0.06  0.10  0.33  0.07        1.4×
mysql2 query() inline literals     300  0.05  0.06  0.10  0.21  0.07        1.6×
@db/mysql query() inline literals  300  0.05  0.06  0.14  0.31  0.08        1.6×
@db/mysql query() with params      300  0.05  0.07  0.16  0.39  0.10        1.8×
mysql2 query() text protocol       300  0.06  0.08  0.16  0.31  0.10        2.0×
mysql2 execute() prepared          300  0.06  0.09  0.16  0.47  0.12        2.1×
```

Against **MariaDB 11.8.8** the ordering and magnitudes are the same (mariadb
connector p50 0.05 ms; mysql2 0.08 ms; @db/mysql 0.08 ms).

**The key negative result:** every driver's parameterized path tracks its
inline-literal control within ~2×at sub-0.1 ms absolute levels. **No candidate
has a `@db/postgres`-class stall** — all set `TCP_NODELAY`/coalesce writes
properly. At these magnitudes the 2× between mariadb and mysql2 is real but
immaterial next to any actual query or network hop.

## Pooled throughput (pool = 8, 2 000 prepared queries)

| Driver  | MySQL 8.4.10 | MariaDB 11.8.8 |
| ------- | ------------ | -------------- |
| mariadb | ~24 500 qps  | ~24 200 qps    |
| mysql2  | ~20 200 qps  | ~16 200 qps    |

(`@db/mysql` was not pool-benched; it ships `MysqlClientPool` but is already out
of contention for the default.)

## Value shapes (defaults, from a real table)

Columns: `bigint` (holding 9007199254740993 = 2⁵³ + 1), `decimal(10,2)`,
`datetime`, `tinyint(1)`, `json`.

| Driver       | `BIGINT`                         | `DECIMAL` | `DATETIME` | `TINYINT(1)` | `JSON`        |
| ------------ | -------------------------------- | --------- | ---------- | ------------ | ------------- |
| mysql2       | **`number` — LOSSY** (…93 → …92) | `string`  | `Date`     | `number`     | parsed object |
| mariadb      | `BigInt` ✓                       | `string`  | `Date`     | `number`     | parsed object |
| @db/mysql rc | `BigInt` ✓                       | `string`  | `Date`     | `number`     | **`string`**  |

- **mysql2's default `BIGINT` decode silently truncates** past 2⁵³. With
  `supportBigNumbers: true, bigNumberStrings: true` it decodes to a
  precision-safe **`string`** (verified) — which happens to match
  `@sisal/neon`'s bigint-as-string convention and the "all → string" option in
  the open cross-adapter `bigint` alignment decision. The v0.7 executor must set
  these options.
- The mariadb connector's prepared path can also surface plain integers as
  `BigInt` (observed on Node: `select ? as b` → `1n`), configurable via its
  `bigIntAsNumber`/`decimalAsNumber` options — a C4 type-mapping input.
- No driver decodes `TINYINT(1)` as boolean by default (`BOOLEAN` = `TINYINT(1)`
  in MySQL); the adapter owns that mapping (C4).

## Dual-runtime check (the npm door-open constraint)

Verified first-hand, not assumed: the same parameterized query ran against MySQL
8.4.10 from **Deno 2.9.0** (via `npm:` specifiers, the benchmark above) and from
**Node v26.4.0** (via `node_modules`) for both `mysql2` and `mariadb`.
`jsr:@db/mysql` is Deno-only.

## Survey matrix

|                               | `npm:mysql2` 3.22.5      | `npm:mariadb` 3.5.3       | `jsr:@db/mysql` 3.0.0-rc.1  | `npm:@planetscale/database` 1.20.1 |
| ----------------------------- | ------------------------ | ------------------------- | --------------------------- | ---------------------------------- |
| License                       | MIT                      | **LGPL-2.1-or-later**     | MIT                         | Apache-2.0                         |
| Runtimes                      | Deno + Node ✓ (verified) | Deno + Node ✓ (verified)  | **Deno only**               | Deno + Node + edge (fetch)         |
| MySQL 8 `caching_sha2`        | ✓                        | ✓                         | ✓ (verified)                | n/a (HTTP)                         |
| Pooling                       | `createPool` ✓           | `createPool` ✓            | `MysqlClientPool`           | connectionless                     |
| True prepared stmts           | `execute()` + cache ✓    | `execute()`/`prepare()` ✓ | unclear in rc               | no (HTTP)                          |
| TLS                           | ✓                        | ✓                         | `TlsMode`                   | always (HTTPS)                     |
| Maintenance (checked 2026-07) | active (2026-06)         | active (2026-06)          | **rc only, `latest: null`** | active (2026-03)                   |
| Verdict                       | **default**              | perf/licensing opt-in     | watch                       | future serverless variant          |

## How this feeds v0.7

- The adapter keeps the family pattern: lazily-imported default driver
  (`mysql2`), injectable executor, opt-in alternate driver — no new
  architecture.
- The executor's mysql2 config is part of the adapter contract:
  `supportBigNumbers + bigNumberStrings` (precision), plus decisions on
  `decimalNumbers` (keep `string`) and JSON handling — pinned by the future
  `integration/_shared/mysql_family_scenarios.ts` value-shape assertions.
- The `IntegrationTarget` capability/value-shape descriptors added by the
  integration consolidation already have the fields these facts slot into
  (`valueShape.numeric`, `capabilities.returning = false`, …).

## Reproduce

```sh
docker run -d --rm --name sisal-mysql84 -e MYSQL_ROOT_PASSWORD=root \
  -e MYSQL_DATABASE=sisal -p 33084:3306 mysql:8.4
MYSQL_URL=mysql://root:root@localhost:33084/sisal deno task perf:mysql

docker run -d --rm --name sisal-mariadb11 -e MARIADB_ROOT_PASSWORD=root \
  -e MARIADB_DATABASE=sisal -p 33110:3306 mariadb:11
MYSQL_URL=mysql://root:root@localhost:33110/sisal \
  MYSQL_SERVER_LABEL=mariadb11 deno task perf:mysql
```
