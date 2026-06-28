# PostgreSQL rising feed (Sisal example)

The **normal database** version of the Reddit-style **`/rising`** feed: a
regular **PostgreSQL 18** connection via [`@sisal/pg`](../../packages/pg/). Same
product behavior as the Neon and libSQL siblings — posts, 5-minute activity
buckets, unique-actor dedup, a weighted bucket score, a stored, time-dependent
`rising_score`, `/new` + `/rising` with keyset pagination — but with **no
serverless execution constraint**.

It is **not** an app — no auth, no HTTP server, no frontend, no comments tree,
no moderation UI. Just the database/feed mechanics, three ways.

## The three-way comparison

This example exists to compare three database environments running the **same**
feature:

| Environment              | Example                                        | Adapter         | Database features                                    | Runtime shape             | Main lesson                    |
| ------------------------ | ---------------------------------------------- | --------------- | ---------------------------------------------------- | ------------------------- | ------------------------------ |
| **Normal PostgreSQL 18** | **`postgres-rising-feed`** (this one)          | `@sisal/pg`     | functions/procedures, regular sessions, transactions | normal TCP Postgres       | full database feature baseline |
| **Neon / Postgres**      | [`neon-rising-feed`](../neon-rising-feed/)     | `@sisal/neon`   | Postgres functions, serverless execution constraints | single-statement friendly | constrained Postgres runtime   |
| **libSQL / Turso**       | [`libsql-rising-feed`](../libsql-rising-feed/) | `@sisal/libsql` | no SQL stored procedures                             | TS transactions / batch   | feature-limited database       |

- **Normal Postgres** (here): a regular connection/session model. Interactive
  transactions are perfectly acceptable, and so are PostgreSQL functions. This
  is the baseline: every database feature is available.
- **Neon** uses the _same database-side idea_ (Postgres functions) but for a
  serverless, single-statement-friendly execution model — it avoids holding a
  connection open across an interactive transaction callback.
- **libSQL** _cannot_ use SQL stored procedures at all, so the same multi-step
  logic moves into TypeScript (`db.transaction(...)` / `db.batch(...)`).

## Why this example still uses PostgreSQL functions

Even though normal Postgres could do everything with interactive transactions,
the activity recorder still prefers a **PostgreSQL function**
(`app.record_post_activity`) because it keeps the multi-step mutation **atomic
and database-local in a single round trip** — the cleanest way to centralize the
logic. Unlike libSQL (which has no stored procedures), Postgres supports this
database-side approach.

Because the connection is a normal session, this example _also_ ships the
interactive-transaction alternative so you can see both:

- **`recordPostActivity`** (primary) → `db.call(app.record_post_activity)` — one
  atomic statement, one round trip. Best for centralizing logic.
- **`recordPostActivityWithTransaction`** (optional) → `db.transaction(tx => …)`
  with the query builder — acceptable on a long-lived connection. The
  integration test asserts both produce identical buckets.

## The rising-score model (shared across all three examples)

Activity is pre-aggregated into **5-minute buckets**; each event bumps a counter
and the bucket's weighted `activity_score`. The stored `rising_score` is a
moving window over recent buckets, recomputed at an **explicit `p_now`** (never
a hidden `now()`), so it is deterministic:

```
activity_score = upvotes*1 + downvotes*(-0.5) + comments*3 + unique_actors*2 + reports*(-8)

last_15m = Σ activity_score over [p_now-15m,  p_now]
last_60m = Σ activity_score over [p_now-60m,  p_now]
prev_60m = Σ activity_score over [p_now-120m, p_now-60m)
accel    = max(last_15m - prev_60m / 4, 0)
rising   = last_15m*3 + last_60m + accel*2
```

`src/rising.ts` mirrors the SQL exactly and is unit-tested against the same
constants. Window boundaries are **inclusive of `p_now`** and exclude any bucket
**after** it — `app.calculate_rising_score` bounds the recent windows with
`bucket_start <= p_now`, so a bucket dated in the future (clock skew, or a
recompute pinned to an earlier `p_now`) can never inflate the score. Buckets
older than 120 minutes also drop out. `/new` orders by `created_at`; `/rising`
filters `rising_score > 0` and orders by
`rising_score DESC, rising_score_updated_at DESC, id DESC` with a row-value
keyset.

## How to run

Prerequisites: [Deno](https://deno.com/) 2.x and Docker.

```sh
cd examples/postgres-rising-feed
cp .env.example .env
docker compose up -d          # start PostgreSQL 18 locally

deno task migrate             # create tables, indexes, and functions
deno task seed                # insert 24 deterministic posts + activity
deno task demo                # print /new and /rising, boost a post, repaginate
```

`deno task demo` is self-contained: it migrates idempotently and reseeds at a
fixed `DEMO_NOW`. Start clean with `deno task demo -- --reset`. Other tasks:
`deno task reset` (drop + re-migrate), `deno task recompute` (recompute at the
real clock — right after a `seed` pinned to `DEMO_NOW` this zeroes scores, which
is expected).

When you're done: `docker compose down -v`.

## Adapter note: `double precision` round-trips as a string

`@sisal/pg` currently returns `double precision` columns as **strings**
(integers come back as numbers), so this example `Number(...)`-coerces
`rising_score` / `activity_score` at the query boundary (`src/queries.ts`,
`src/recompute.ts`, `src/activity.ts`) to honor the typed `number` contract. The
`@sisal/neon`, `@sisal/sqlite`, and `@sisal/libsql` adapters already return a
`number`; a float→number coercion in `@sisal/pg` would remove this step. Tracked
in the [v0.5.0 roadmap](../../docs/v0.5.0-roadmap.md) (item 11).

## Production notes

This example keeps the recompute path deliberately simple and optimizes for
clarity, not maximum production sophistication. At scale you'd:

- **Recompute only dirty / recently-active posts**, not every published post —
  `recomputeAllRisingScores` rescans everything; drive it from a `dirty` set
  written by the recorder, or scan `post_activity_buckets` for recent buckets.
- **Retain or consolidate old buckets** — buckets older than the 120-minute
  window can never affect a score again; delete or roll them up periodically so
  `post_activity_buckets` doesn't grow without bound.

## Tests

```sh
# network-free unit tests (the rising-score model + the SQL splitter)
deno task test

# database-backed integration test — RESETS the target DB; use a scratch DB
docker compose up -d
SISAL_POSTGRES_RISING_FEED_IT=1 \
  DATABASE_URL="postgres://sisal:sisal@localhost:5432/sisal_rising_feed" \
  deno test -A feed_db_test.ts
docker compose down -v
```

`feed_db_test.ts` covers bucket creation, unique-actor dedup, weight ordering
(comments > upvotes; reports penalize), stored `rising_score` matching the
TypeScript model, deterministic recompute, moving-window decay, **future buckets
excluded**, `/rising` ordering, keyset pagination without duplicates, and that
the interactive-transaction recorder agrees with the database-function recorder.

## Files

```
examples/postgres-rising-feed/
  README.md
  deno.json                 tasks + JSR imports
  .env.example              DATABASE_URL + DATABASE_DIRECT_URL
  docker-compose.yml        local PostgreSQL 18
  mod.ts                    entrypoint; re-exports + runs the demo
  rising_test.ts            network-free unit tests
  feed_db_test.ts           gated database integration test
  migrations/
    0001_init.sql                 tables + DESC keyset indexes
    0002_bucket_functions.sql     app.bucket_5m (IMMUTABLE)
    0003_activity_functions.sql   weights + app.record_post_activity (atomic)
    0004_rising_score_functions.sql  calculate / recompute rising scores
  src/
    db.ts                   @sisal/pg connections
    schema.ts               typed defineTable models (Date mode timestamps)
    rising.ts               TypeScript mirror of the scoring model
    activity.ts             recordPostActivity (function) + …WithTransaction
    queries.ts              getNewFeed + getRisingFeed (both .keyset())
    recompute.ts            recompute one / all rising scores (typed db.call)
    seed.ts                 deterministic posts + activity at DEMO_NOW
    migrate.ts              applies .sql files via @sisal/migrate splitter
    main.ts                 the demo
```
