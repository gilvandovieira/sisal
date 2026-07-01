---
title: MySQL type & DDL mapping
---

# MySQL type & DDL mapping — the C4 report (v0.6.0 workstream C)

**Date:** 2026-07-01 · **Probe:**
[`perf/mysql_ddl_probe.ts`](../perf/mysql_ddl_probe.ts)
(`deno task perf:mysql:ddl`) · **Verified against:** MySQL **8.4.10** and
MariaDB **11.8.8** (Docker), decoded through the C6-chosen driver (`npm:mysql2`
with the mandated `supportBigNumbers` + `bigNumberStrings`)

This is the design the v0.7 `generateMysqlUpStatements` implements. Every
mapping and every quirk below was **executed against both live engines** — the
probe applies the full proposed `CREATE TABLE`, round-trips a rich row, and runs
one probe per DDL rule. Nothing here is assumed from documentation.

The generator follows the existing architecture exactly
(`packages/pg/migrate/ddl.ts` is the template): pure snapshot → SQL strings,
additive-only statements, destructive changes withheld, foreign keys emitted as
`ALTER TABLE … ADD FOREIGN KEY` **after** every `CREATE TABLE`, then indexes,
then dialect-selected schema objects.

## Column type mapping (probe-verified)

| Sisal kind                   | MySQL DDL                        | Round-trip via mysql2¹                          | Notes                                                                                                                                                                                                                                                                                     |
| ---------------------------- | -------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`                       | `TEXT`                           | `string`                                        | 64 KB limit; `customType` for `MEDIUMTEXT`/`LONGTEXT`. **Cannot be a key** (see quirks) and **cannot take a literal default on MySQL** (paren-expression form required).                                                                                                                  |
| `varchar(n)`                 | `VARCHAR(n)`                     | `string`                                        | `VARCHAR(255)` when `n` omitted (a MySQL length is mandatory).                                                                                                                                                                                                                            |
| `char(n)`                    | `CHAR(n)`                        | `string`                                        |                                                                                                                                                                                                                                                                                           |
| `integer`                    | `INT`                            | `number`                                        |                                                                                                                                                                                                                                                                                           |
| `smallint`                   | `SMALLINT`                       | `number`                                        |                                                                                                                                                                                                                                                                                           |
| `bigint`                     | `BIGINT`                         | `string` ✓                                      | Precision-safe **only** with the C6-mandated driver options; verified with 2⁵³+1.                                                                                                                                                                                                         |
| `serial`                     | `INT NOT NULL AUTO_INCREMENT`    | `number`                                        | Must be a key; max one per table (both rules engine-enforced — generator validates, see quirks).                                                                                                                                                                                          |
| `bigserial`                  | `BIGINT NOT NULL AUTO_INCREMENT` | `string`                                        | Same rules.                                                                                                                                                                                                                                                                               |
| `numeric(p,s)` / `decimal`   | `DECIMAL(p,s)`                   | `string` ✓                                      | Matches the pg `numeric` convention.                                                                                                                                                                                                                                                      |
| `real`                       | `FLOAT`                          | `number`                                        | Explicit `FLOAT` — MySQL's `REAL` means `DOUBLE` unless `REAL_AS_FLOAT`.                                                                                                                                                                                                                  |
| `double` / `float`           | `DOUBLE`                         | `number`                                        |                                                                                                                                                                                                                                                                                           |
| `boolean`                    | `BOOLEAN`                        | `number` `0`/`1` ⚠                              | Both engines store it as `TINYINT(1)` (probe-verified); round-trips like the SQLite family.                                                                                                                                                                                               |
| `json` / `jsonb`             | `JSON`                           | MySQL: **parsed** ✓ · MariaDB: **`string`** ⚠   | MariaDB's `JSON` is a `LONGTEXT` alias, so the driver sees text — the C5 divergence. No binary variant; `jsonb` ≡ `json`.                                                                                                                                                                 |
| `date`                       | `DATE`                           | `Date` (local midnight)                         | Same local-`Date` convention as neon's raw `date`; the adapter's temporal layer owns normalization (mysql2 has `dateStrings`).                                                                                                                                                            |
| `time`                       | `TIME(6)`                        | `string`                                        | `(6)` preserves pg's microsecond precision.                                                                                                                                                                                                                                               |
| `timestamp`                  | `DATETIME(6)`                    | `Date` (ms precision)                           | No timezone conversion, no range cliff — the safe default.                                                                                                                                                                                                                                |
| `timestamptz`                | `TIMESTAMP(6) NULL`              | `Date`                                          | Session-tz-converting, **but range ends 2038-01-19 on MySQL** (probe: rejects `2040-01-01`; MariaDB 11.8 accepts it — extended range). Explicit `NULL` documents nullability against legacy implicit-default modes. Alternative if 2038 matters: `DATETIME(6)` + executor UTC convention. |
| `uuid`                       | `CHAR(36)`                       | `string`                                        | No native type on MySQL (MariaDB 10.7+ has one — C5). `DEFAULT (uuid())` works on both (probe-verified).                                                                                                                                                                                  |
| `bytea` / `blob`             | `LONGBLOB`                       | `Buffer` (a `Uint8Array` subclass)              | `BLOB` is only 64 KB; `LONGBLOB` (4 GB) is the faithful `bytea` analogue.                                                                                                                                                                                                                 |
| `.array()`                   | `JSON`                           | MySQL: **parsed array** ✓ · MariaDB: `string` ⚠ | No array type; JSON is strictly better than the SQLite family's plain-`TEXT` serialization on MySQL proper.                                                                                                                                                                               |
| `customType` / `dialectType` | verbatim                         | —                                               | The same trusted escape hatch (SEC-006) as pg.                                                                                                                                                                                                                                            |

¹ With `supportBigNumbers: true, bigNumberStrings: true` — **mandatory** (C6):
mysql2's default `BIGINT` decode silently truncates past 2⁵³.

## DDL generation rules (each backed by a probe finding)

1. **Identifier quoting: backticks**, escaping embedded backticks
   (``quoteMysqlIdent(`a\`b`) →`` `a`b``) — the DDL-side counterpart of the
   renderer's `quoteIdentifier(name, "mysql")`.
2. **Foreign keys: table-level only, after all `CREATE TABLE`s** — the pg
   generator's existing ordering. Probe: an inline column `REFERENCES` clause is
   **silently ignored by MySQL** (no constraint in `information_schema`) while
   MariaDB honors it — inline emission would create schemas that differ
   _silently_ per engine. `ALTER TABLE … ADD
   FOREIGN KEY` works identically
   on both.
3. **Defaults.** Literal defaults render as on pg **except** on
   `TEXT`/`BLOB`/`JSON` columns, where MySQL rejects them outright
   (`…can't have a default value`); MariaDB accepts them. The portable form —
   accepted by **both** engines (probe-verified) — is the parenthesized
   expression default: `DEFAULT ('{}')`, `DEFAULT (uuid())`. Rule: wrap
   `expression` defaults in parens always, and literal defaults in parens when
   the column type is TEXT/BLOB/JSON-mapped. (Requires MySQL 8.0.13+ — the
   version floor below.)
4. **`AUTO_INCREMENT` validation.** Both engines enforce: at most one
   auto-increment column per table and it must be a key. The generator validates
   `serial`/`bigserial` placement at generation time and throws a typed error,
   rather than shipping SQL that fails at apply time.
5. **Keys on `TEXT`/`BLOB` need prefix lengths** (both engines reject a bare
   `TEXT` primary key/index). The generator throws a typed error pointing at
   `varchar(n)` — silently inventing a prefix length would change semantics.
6. **No `IF NOT EXISTS` on `CREATE INDEX`** — MySQL rejects the clause (MariaDB
   accepts it). The pg/sqlite generators don't emit it either, so nothing
   changes; recorded so nobody "harmonizes" it in later.
7. **Indexes.** `DESC` ✓ both. **Functional indexes (`((expr))`) are
   MySQL-8-only** (MariaDB rejects; its route is generated columns) — expression
   index columns throw a typed error under the version-less dialect and graduate
   with the `(engine, variant)` axis. **Partial indexes (`WHERE`) are
   unsupported on both** — typed error, same rationale.
8. **`CHECK` constraints emit as-is** — enforced on both (probe-verified;
   floors: MySQL 8.0.16, MariaDB 10.2).
9. **No `ENGINE`/`CHARSET` clause.** Both modern engines default to InnoDB +
   utf8mb4; emitting an explicit collation is a trap because the names differ
   per engine (`utf8mb4_0900_ai_ci` is MySQL-only). Server defaults win; a
   table-options escape hatch can come later if asked for.
10. **No implicit `TIMESTAMP` magic to fight** on the supported floor: both
    MySQL 8.4 and MariaDB 11.8 ship `explicit_defaults_for_timestamp = ON`
    (probe: a plain `TIMESTAMP` column gets no `CURRENT_TIMESTAMP`
    default/on-update). MariaDB only flipped that default in 10.10 — part of the
    version floor.
11. **Schema objects** (`schemaObjects`) reuse the dialect-selection machinery
    (`selectSchemaObjects(to, from, "mysql")`); note for authors: MySQL has no
    dollar-quoting, and `DELIMITER` is a client artifact — a trigger/procedure
    body must be written as a single statement, which the one-statement-per-
    `execute` migration executor sends fine.
12. **Migrator lock:** `GET_LOCK('sisal_migrations', timeout)` / `RELEASE_LOCK`
    is the `pg_advisory_lock` analogue for the history store — also the answer
    A2 (ETL locking) will want for the MySQL column of its matrix.

## Version floor

The rules above assume **MySQL ≥ 8.0.16** (paren expression defaults 8.0.13,
enforced `CHECK` 8.0.16, functional indexes 8.0.13) and **MariaDB ≥ 10.10**
(`explicit_defaults_for_timestamp = ON` default; enforced `CHECK` since 10.2).
Verified concretely on 8.4.10 and 11.8.8. MySQL 5.7 is out: no `CHECK`
enforcement, no expression defaults, `caching_sha2_password` absent.

## MariaDB divergences found (input for C5)

| Behavior                       | MySQL 8.4.10         | MariaDB 11.8.8                         |
| ------------------------------ | -------------------- | -------------------------------------- |
| Inline column `REFERENCES`     | **silently ignored** | honored                                |
| `TEXT`/`JSON` literal defaults | rejected             | accepted                               |
| `CREATE INDEX IF NOT EXISTS`   | rejected             | accepted                               |
| Functional index `((expr))`    | accepted             | **rejected**                           |
| `TIMESTAMP` beyond 2038        | rejected             | **accepted** (extended range)          |
| `JSON` decode via mysql2       | parsed object/array  | **`string`** (`LONGTEXT` alias)        |
| Native `UUID` type             | none (`CHAR(36)`)    | exists (10.7+, unused by this mapping) |

The strictest-common-denominator rules above produce DDL that behaves
identically on both engines; the rows where MariaDB is _more_ capable (extended
`TIMESTAMP`, `IF NOT EXISTS`) are exactly the `(engine, variant)` material C5
and the dialect-identity decision own.

## What this hands v0.7

- `generateMysqlUpStatements` is a mechanical sibling of
  `generatePostgresUpStatements`: same module shape, same additive/destructive
  split, same FK/index/schema-object ordering — plus the type table and the
  three generation-time validations above (auto-increment placement, TEXT keys,
  partial/functional indexes).
- The adapter's `IntegrationTarget` descriptor fields fall straight out of the
  probe:
  `valueShape = { boolean: "integer", json: "parsed" (mysql), array:
  "jsonText"-equivalent via JSON, binary: "uint8array" (Buffer), numeric:
  "string", dateTrunc: n/a until the date-helper variants land }`,
  `capabilities = { returning: false, distinctOn: false, nativeArrays: false,
  … }`.
- Two executor obligations recorded: the C6 driver options (bigint precision)
  and `TINYINT(1)` → the adapter decides whether to surface `boolean` columns as
  `0`/`1` (SQLite-family precedent) or decode to `boolean` at the executor.

## Reproduce

```sh
docker run -d --rm --name sisal-mysql84 -e MYSQL_ROOT_PASSWORD=root \
  -e MYSQL_DATABASE=sisal -p 33084:3306 mysql:8.4
MYSQL_URL=mysql://root:root@localhost:33084/sisal deno task perf:mysql:ddl

docker run -d --rm --name sisal-mariadb11 -e MARIADB_ROOT_PASSWORD=root \
  -e MARIADB_DATABASE=sisal -p 33110:3306 mariadb:11
MYSQL_URL=mysql://root:root@localhost:33110/sisal \
  MYSQL_SERVER_LABEL=mariadb11 deno task perf:mysql:ddl
```
