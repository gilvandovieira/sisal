---
title: Neon compatibility
---

# Neon compatibility

Sisal's Neon adapter (`@sisal/neon`) targets [Neon](https://neon.tech)
serverless PostgreSQL. It speaks the Postgres wire protocol over a WebSocket via
`jsr:@neon/serverless` and **reuses the Postgres SQL dialect and DDL**, so its
feature surface matches `@sisal/pg` exactly — including native `ILIKE` and
`bytea`.

| Item          | Value                                                    |
| ------------- | -------------------------------------------------------- |
| Engine tested | **PostgreSQL 17** behind Neon's `wsproxy` image + driver |
| Driver        | `jsr:@neon/serverless@1.0.1` (WebSocket `Pool`)          |
| Suite         | `integration/neon_features_test.ts` (32 tests)           |
| Last run      | 2026-06-30 — **32 / 32 passed** (neon-proxy + live Neon) |

## Feature coverage

Every feature across all four adapters — each ✅/⚠️ backed by a named
integration test — lives in the unified
[cross-driver feature matrix](feature-matrix.md), verified by
`deno task docs:matrix:check`. Neon reuses the full `@sisal/pg` SQL surface, so
every Postgres-family ✅ applies. The 31-test suite is verified through the
Docker `neon-proxy` (Neon's `wsproxy` image → PostgreSQL 17) and was
additionally run once end-to-end against a **live Neon endpoint** (2026-06-30,
secure WebSocket, no proxy) — all green.

The generated DDL test exercises the full Postgres type set (`text`,
`varchar(n)`, `char(n)`, `integer`, `smallint`, `bigint`, `serial`, `bigserial`,
`numeric(p,s)`, `real`, `double precision`, `boolean`, `json`, `jsonb`, `date`,
`time`, `timestamp`, `timestamptz`, `uuid`, `text[]`, `bytea`).

## Behavior notes

> The cross-driver feature support and round-trip summary live in the
> [feature-matrix reference](feature-matrix.md#round-trip-differences); the
> notes below are Neon-specific.

- **Same SQL as `@sisal/pg`.** Neon is PostgreSQL, so values come back typed the
  way Postgres returns them — `jsonb`/arrays parsed, `bytea` as `Uint8Array`,
  `numeric`/`bigint` as precision-preserving strings, native `ILIKE`.
- **Full `@sisal/pg` surface, verified.** Column naming, keyset pagination,
  prepared statements, `sql` expressions in `SET`/`VALUES`/`onConflict`,
  `db.batch`, rich indexes, and the typed function caller (`defineFunction` /
  `db.call`, incl. `RETURNS TABLE` and arg casts) all run through
  `createPgOrmDriver` + `POSTGRES_DIALECT` and are now covered by the suite —
  same render path and results as `@sisal/pg`.
- **Date/time semantics.** The ORM defaults to Temporal: `date` ->
  `Temporal.PlainDate`, `time` -> `Temporal.PlainTime`, `timestamp` ->
  `Temporal.PlainDateTime`, and `timestamptz` -> `Temporal.Instant`. Enable
  result decoding with `temporal: { parse: true }`; use explicit `mode: "date"`
  or `mode: "string"` for legacy/runtime-specific behavior.
  `columns.timestamp()` emits `timestamp`; pass `{ withTimezone: true }` for
  `timestamptz`.
- **Serverless transport.** The adapter uses the WebSocket `Pool` from
  `@neon/serverless` (full protocol, real transactions), not the HTTP one-shot
  `neon()` function. Real usage just needs a Neon connection string:
  `connect({ url: "postgres://…@ep-xxx.neon.tech/db?sslmode=require" })`. The
  local test path therefore runs Neon's official **`wsproxy`** image (the
  `neon-proxy` service) to terminate that WebSocket protocol in front of a
  Postgres data backend — **not Neon Local** (`neondatabase/neon_local`), which
  is HTTP-only and so cannot drive the WebSocket `Pool`. Against real Neon no
  proxy is needed: the driver speaks secure WebSocket to the endpoint directly.
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
