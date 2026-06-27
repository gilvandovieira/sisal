---
title: Neon compatibility
---

# Neon compatibility matrix

Sisal's Neon adapter (`@sisal/neon`) targets [Neon](https://neon.tech)
serverless PostgreSQL. It speaks the Postgres wire protocol over a WebSocket via
`jsr:@neon/serverless` and **reuses the Postgres SQL dialect and DDL**, so its
feature surface matches `@sisal/pg` exactly — including native `ILIKE` and
`bytea`.

| Item          | Value                                                   |
| ------------- | ------------------------------------------------------- |
| Engine tested | **PostgreSQL 17** via the Neon serverless driver        |
| Driver        | `jsr:@neon/serverless@1.0.1` (WebSocket `Pool`)         |
| Suite         | `integration/neon_features_test.ts` (17 feature groups) |
| Last run      | 2026-06-27 — **17 / 17 passed**                         |

✅ = verified on a live server.

## Matrix

| Feature                                                        | Neon |
| -------------------------------------------------------------- | :--: |
| **Connection** — `connect({ url })`, pooled, parameterized SQL |  ✅  |
| **Generated DDL applies** — all Postgres column types          |  ✅  |
| **Insert** — `values`, multi-row, `returning`                  |  ✅  |
| **Comparison** — `eq` `ne` `gt` `gte` `lt` `lte`               |  ✅  |
| **Pattern** — `like` `ilike` `notLike` `notIlike`              |  ✅  |
| **Range** — `between` `notBetween`                             |  ✅  |
| **Set** — `inArray` `notInArray`                               |  ✅  |
| **Null** — `isNull` `isNotNull`                                |  ✅  |
| **Logical** — `and` `or` `not`                                 |  ✅  |
| **Ordering** — `asc`/`desc`, multi-key, `limit`, `offset`      |  ✅  |
| **Distinct**                                                   |  ✅  |
| **Joins** — `inner` / `left` / `right` / `full`                |  ✅  |
| **Aggregates** — `count` `sum` `avg` `min` `max`               |  ✅  |
| **Group / filter** — `groupBy`, `having`                       |  ✅  |
| **Update** — `set`, `where`, `returning`, `$onUpdate`          |  ✅  |
| **Delete** — `where`, `returning`                              |  ✅  |
| **Upsert** — `onConflictDoNothing` / `onConflictDoUpdate`      |  ✅  |
| **Transactions** — commit + rollback on error                  |  ✅  |
| **JSONB** — object round-trip                                  |  ✅  |
| **Arrays** — `text[]` round-trip                               |  ✅  |
| **Binary** — `bytea` round-trip (`Uint8Array`)                 |  ✅  |
| **Migrator** — apply, plan, history table, idempotent re-run   |  ✅  |

The generated DDL test exercises the full Postgres type set (`text`,
`varchar(n)`, `char(n)`, `integer`, `smallint`, `bigint`, `serial`, `bigserial`,
`numeric(p,s)`, `real`, `double precision`, `boolean`, `json`, `jsonb`, `date`,
`timestamp`, `timestamptz`, `uuid`, `text[]`, `bytea`).

## Behavior notes

- **Same SQL as `@sisal/pg`.** Neon is PostgreSQL, so values come back typed the
  way Postgres returns them — `jsonb`/arrays parsed, `bytea` as `Uint8Array`,
  `numeric`/`bigint` as precision-preserving strings, native `ILIKE`.
- **Serverless transport.** The adapter uses the WebSocket `Pool` from
  `@neon/serverless` (full protocol, real transactions), not the HTTP one-shot
  `neon()` function. Real usage just needs a Neon connection string:
  `connect({ url: "postgres://…@ep-xxx.neon.tech/db?sslmode=require" })`.
- **Joins.** As with `@sisal/pg`, use explicit projections in joins rather than
  `select *` so duplicate column names across tables don't collide in the
  row-object mapping.

## Reproduce

```sh
# Against real Neon
NEON_DATABASE_URL="postgres://user:pw@ep-xxx.neon.tech/db?sslmode=require" \
  deno test -A integration/neon_features_test.ts

# Against a local Postgres through the bundled WebSocket proxy
docker compose -f docker/compose.yaml up -d neon-proxy
NEON_DATABASE_URL="postgres://postgres:postgres@localhost/sisal" \
  NEON_WS_PROXY="localhost:5499" \
  deno test -A integration/neon_features_test.ts
```

The suite is **skipped when `NEON_DATABASE_URL` is unset**, so it never runs (or
needs network) during the ordinary `deno task test`.
