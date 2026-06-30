# Neon rising feed — CTE edition (Sisal example)

The same Reddit-style **`/rising`** feed as
[`neon-rising-feed`](../neon-rising-feed/), on **Neon / PostgreSQL** via
[`@sisal/neon`](../../packages/neon/) — but with **no database functions**. No
`CREATE FUNCTION`, no `CREATE PROCEDURE`, no PL/pgSQL, no triggers. Every
multi-step mutation is expressed as **one data-modifying CTE statement** sent
from TypeScript.

It is **not** an app — no auth, no HTTP server, no frontend, no comments tree,
no moderation UI, no background workers, no cron. Just posts, time-bucketed
activity, a moving-window score, and the raw-SQL CTE escape hatch.

## What this example proves

1. Sisal works with Neon/Postgres for **time-bucketed activity**.
2. A **moving-average / rising** score can be modeled **without database
   functions**.
3. Multi-step **activity recording** is one atomic SQL statement (a CTE).
4. Multi-step **rising-score recompute** is one atomic SQL statement (a CTE).
5. Sisal's **raw-SQL CTE escape hatch** is good enough for advanced Postgres
   patterns that the fluent builder cannot express.
6. Sisal's fluent-API boundaries are documented honestly (see
   [Sisal API pressure points](#sisal-api-pressure-points)).
7. A stored, indexed `rising_score` powers a `/rising` timeline efficiently.

## What is a moving average (in small words)

Instead of "how much activity ever?", a moving average asks "how much activity
**lately**?" Slice time into small windows, count activity in each, and add up
the **recent** windows — old windows fall off the back. A post with 1,000 votes
yesterday but nothing this hour has a **low** moving average; a post getting 30
votes _right now_ has a **high** one. That is what makes a feed "rising".

## What is a time bucket

A **time bucket** is a fixed slice of time that activity is grouped into. This
example uses **5-minute buckets**: every upvote/downvote/comment/report is
folded into the counters of the bucket its timestamp falls in (e.g. 12:37 → the
12:35 bucket). Pre-aggregating into buckets means a moving-window score is a
small **sum over a handful of recent buckets**, not a scan over every event.

## Important product distinction

Keep these three feeds separate — they answer different questions:

- **`/new`** — _newest content_. Order by `created_at`. No scoring.
- **`/hot`** — _good and recent_. A score that is roughly **stable** for a given
  (votes, age) pair.
- **`/rising`** — _gaining attention right now_. A **time-dependent**
  moving-window score over recent activity.

This example is **only** about `/rising` (and `/new` for contrast). It does
**not** mix in `/hot`.

## Why `/rising` needs recent activity, a stored score, and explicit `p_now`

- **Recent activity**: "rising" means _accelerating now_, so the score sums only
  buckets in the last 15 / 60 / 120 minutes. Old activity is irrelevant.
- **Stored, not per-request**: computing the moving window for **every** post on
  **every** feed request would re-scan buckets constantly and can't be indexed
  for an ordered feed. So the result is **stored** in `posts.rising_score` and
  indexed (`posts_rising_feed_idx`); the feed is an ordered keyset scan, and the
  score is refreshed by an explicit recompute (`deno task recompute`, a cron, or
  right after recording activity).
- **Explicit `p_now`**: a rising score is **time-dependent** — it changes as the
  clock moves even with no new activity. Every CTE takes the reference time as a
  bound parameter (`p_now` / `now_at`) instead of reading `now()` inside the
  SQL, so seeding and tests are deterministic and the time-dependence is
  explicit. The TypeScript mirror (`calculateRisingScoreTs`) follows the same
  rule.

## The model (weights + formula)

`activity_score` per bucket, from its counters (these are **product-tuning**
values, not universal truth — change them for your app):

```
upvote = +1   downvote = -0.5   comment = +3   unique actor = +2   report = -8

activity_score = upvotes*1 + downvotes*(-0.5) + comments*3 + unique_actors*2 + reports*(-8)
```

`rising_score` from the moving window at `p_now`:

```
last_15m = Σ activity_score over [p_now-15m,  p_now]
last_60m = Σ activity_score over [p_now-60m,  p_now]
prev_60m = Σ activity_score over [p_now-120m, p_now-60m)
accel    = max(last_15m - prev_60m / 4, 0)
rising   = last_15m*3 + last_60m + accel*2
```

The recent windows are bounded `<= p_now`, so a bucket dated **after** `p_now`
(clock skew, or a recompute pinned to an earlier moment) never inflates the
score; buckets older than 120 minutes drop out entirely.

- **How unique-actor counting reduces spam**: `unique_actors` only grows on an
  actor's **first** touch in a bucket (the `post_activity_actors` insert is
  `ON CONFLICT DO NOTHING`, and the bucket counts it only when a row was
  actually inserted). Ten different people each upvoting once → `+10` upvotes
  **and** `+10×2` unique-actor weight; one person clicking ten times → `+10`
  upvotes but only `+1×2`. Breadth beats volume.
- **Why reports penalize**: `report` carries a large negative weight (`-8`), so
  a report spike drives a bucket's `activity_score` negative and pulls every
  moving-window term down — a flagged post stops rising fast.

## Why CTEs instead of database functions?

This example intentionally avoids `CREATE FUNCTION` and `CREATE PROCEDURE`. Each
multi-step operation is modeled as a **single SQL statement using CTEs**. From
the application side this keeps the operation **Neon HTTP-friendly**: the app
sends one parameterized statement, with no interactive transaction callback
holding a connection open across round trips. The tradeoff is that the SQL
becomes **larger and less reusable** than a named database function.

The recording CTE (`src/activity.ts`) has clearly-named stages:
`input_data → validated_input → bucket_data → actor_insert → actor_flag →
bucket_upsert`.
The recompute CTEs (`src/rising.ts`) are
`input_data → score_windows → computed_score → updated_post(s)`. Each is one
`WITH … SELECT`/`UPDATE … RETURNING` statement.

## CTEs vs database functions

**CTEs:**

- easier to keep close to the TypeScript code
- easier to change during early iteration
- no database-function migration lifecycle
- very explicit
- _can become large and hard to read_
- _repeated logic may be duplicated_ (the weight formula appears in both the
  recording CTE and the recompute CTEs)

**Database functions** (the [`neon-rising-feed`](../neon-rising-feed/)
approach):

- easier to call (`select * from app.record_post_activity(…)`)
- easier to reuse
- hide complex SQL behind a stable database API
- _require migration/versioning discipline_
- _move business logic deeper into Postgres_
- _are a more Postgres-specific public app primitive_

This example chooses CTEs to reveal **how far Sisal's raw-SQL escape hatch goes
before a function helper would be cleaner**. For a stable, reused mutation a
database function is usually nicer; for fast iteration kept next to app code,
CTEs win.

## Keyset pagination for `/rising` (this is NOT a pressure point)

`/rising` filters `status = 'published' AND rising_score > 0` and orders by
`rising_score DESC, rising_score_updated_at DESC, id DESC`. The page boundary is
the three-column keyset predicate
`(rising_score, rising_score_updated_at, id) < (cursor…)`. Despite this
example's raw-SQL theme, the **feeds are builder-native**: Sisal's
`.keyset({ orderBy, after, form: "row-value" })` expresses exactly this
predicate (`src/queries.ts`), so keyset pagination over a computed score did
**not** need raw SQL. `/new` uses the default expanded keyset form. The first
page omits the cursor. The raw SQL in this example is concentrated entirely in
the **mutations**.

## How to run

Prerequisites: [Deno](https://deno.com/) 2.x and a Neon project (any tier).

```sh
cd examples/neon-rising-feed-ctes
cp .env.example .env          # then edit .env with your Neon URLs

deno task migrate             # create tables + indexes (no functions)
deno task seed                # insert 24 deterministic posts + activity (CTEs)
deno task recompute           # recompute stored rising scores (one bulk CTE)
deno task demo                # print /new and /rising, boost a post, repaginate
```

`deno task demo` is self-contained: it migrates idempotently and reseeds at a
fixed `DEMO_NOW`. Start clean with `deno task demo -- --reset`. The `recompute`
task recomputes at the **real** clock — right after a `seed` pinned to
`DEMO_NOW` that zeroes scores (expected); the demo always recomputes at
`DEMO_NOW`.

### Environment variables

- `DATABASE_URL` — runtime / demo queries (pooled Neon URL recommended).
- `DATABASE_DIRECT_URL` — migrations / admin (direct URL); falls back to
  `DATABASE_URL`. This example uses the same `@sisal/neon` adapter for both,
  intentionally mirroring the Neon-only pressure point. The migration runner
  splits the `.sql` file with `splitSqlStatements` (shared from
  `@sisal/migrate`) because the Neon HTTP protocol takes one statement per call.

## What's Sisal-native and what's raw SQL

**Sisal-native:**

- Typed table models with DESC keyset indexes (`src/schema.ts`).
- Post inserts in the seed — `db.insert(posts).values(...)`.
- **Both feeds** — `/new` and `/rising` via `.keyset({ orderBy, after })`,
  including `nextCursor` (`src/queries.ts`).
- `db.$count` and parameterized one-off lookups via the `sql` tag.

**Raw SQL (parameterized, isolated in small wrappers):**

- **The recording CTE** — `recordPostActivity` (`src/activity.ts`): one
  data-modifying `WITH … INSERT … ON CONFLICT … RETURNING` statement.
- **The recompute CTEs** — `recomputePostRisingScore` and
  `recomputeAllRisingScores` (`src/rising.ts`): one
  `WITH … UPDATE … FROM …
  RETURNING` statement each, with `FILTER`ed
  moving-window aggregates, interval math, and the inline 5-minute
  `bucket_start` expression
  (`date_trunc('hour', at) + floor(extract(minute from at) / 5) * interval '5
  minutes'`).
- **The schema migration** — `CREATE TABLE` / `CREATE INDEX` (DESC).

## Sisal API pressure points

Honest gaps this example surfaced. Each is a candidate for the
[v0.5.0 roadmap](../../docs/v0.5.0-roadmap.md).

1. **No data-modifying CTE builder.** `db.$with(name).as(query)` /
   `db.with(...)` build **SELECT-only** CTEs that terminate in a `.select()`.
   There is no way to express a `WITH` whose stages are
   `INSERT`/`UPDATE`/`DELETE … RETURNING`, nor to return rows from such a
   statement through the builder. So the entire activity recorder and both
   recompute paths are raw `sql` strings. **This is the headline gap.**
   (Roadmap.)
2. **`FILTER` aggregates + interval/date math — resolved (v0.5.0 item 9).** The
   moving-window sums
   (`sum(...) FILTER (WHERE bucket_start >= now - interval '15 minutes')`) are
   now builder-native: `filter(sum(...), …)` with `dateSub(now, { minutes })`,
   plus `dateBin` for arbitrary-width buckets. `selectRisingScore` in
   `src/queries.ts` computes the same `score_windows` aggregate the recompute
   CTE runs — read-only, since the atomic _write_ still needs the CTE (point 1).
   So the aggregate left the raw-SQL escape hatch even though the mutation has
   not.
3. **No typed raw-query result mapping.**
   `db.query<T>(sql\`…\`)`trusts the
   caller's`<T>`generic and does no column-metadata-driven decoding. Each CTE's
   result shape is hand-written (`RecordedBucket`,`RecomputedPost`) and trusted;
   there is no`defineTable`-driven
   mapping from a raw CTE result to a typed row. (Roadmap.)
4. **Schema mirror is informational for the mutations.** `src/schema.ts` types
   the builder-native feeds, but the CTE mutations bypass it entirely — the
   `.sql` migration is the source of truth.

Notably **NOT** a pressure point: **keyset pagination over the computed score**
— Sisal's `.keyset({ form: "row-value" })` handles the three-column predicate,
so both feeds stay builder-native (see above). This example does not pretend
otherwise.

> Adapter note: this example runs on `@sisal/neon`, which returns
> `double precision` as a JS `number` and `timestamptz` as a `Date`, so the raw
> CTE result rows are correctly typed with no coercion. On plain PostgreSQL via
> `@sisal/pg`, `double precision` currently round-trips as a **string** (roadmap
> item 11) — you would `Number(...)`-coerce `rising_score` / `activity_score`
> there.

## Where moving averages help

The same pattern — bucket events in time, sum recent windows, store the result —
shows up far beyond social feeds:

- **Social feeds:** rising posts, active discussions, trending communities.
- **Moderation:** report spikes, suspicious vote bursts, sudden activity from
  brand-new accounts.
- **Course platforms:** lessons with rising engagement, or rising
  confusion/comments.
- **E-commerce:** products suddenly getting purchases, views, or wishlist adds.
- **Observability:** rising error rates, latency spikes, throughput changes.
- **Analytics:** trend detection that reacts to a _sustained shift_ without
  overreacting to a single event.

## Production notes

Kept deliberately simple, optimizing for clarity. At scale you'd recompute only
**dirty / recently-active** posts (not every published post), and **retain or
consolidate** buckets older than the 120-minute window so
`post_activity_buckets` doesn't grow without bound.

## Tests

```sh
# network-free unit tests (the rising-score model + the feed SQL)
deno task test

# database-backed integration test — RESETS the target DB; use a scratch branch
SISAL_NEON_RISING_CTE_FEED_IT=1 \
  DATABASE_URL="postgres://user:pw@ep-xxx.neon.tech/db?sslmode=require" \
  deno test -A feed_db_test.ts
```

`feed_db_test.ts` covers: the recording CTE creates a bucket; unique-actor dedup
(same actor twice ≠ +2); a different actor increments `unique_actors`; comments
outweigh upvotes; reports lower `activity_score`; `recomputePostRisingScore`
stores `rising_score` equal to the TypeScript model; `recomputeAllRisingScores`
updates every published post; `/rising` order is non-increasing; keyset
pagination has no duplicates and matches the single-page order; old activity
decays out of the window as `p_now` advances; deterministic `p_now` ⇒
deterministic scores; and an invalid activity kind is rejected (the CTE returns
no rows, so the wrapper throws).

## Files

```
examples/neon-rising-feed-ctes/
  README.md
  deno.json                 tasks + JSR imports
  .env.example              DATABASE_URL + DATABASE_DIRECT_URL
  mod.ts                    entrypoint; re-exports + runs the demo
  rising_test.ts            network-free unit tests
  feed_db_test.ts           gated database integration test
  migrations/
    0001_init.sql           tables + DESC keyset indexes (NO functions)
  src/
    db.ts                   runtime vs admin connections (@sisal/neon)
    schema.ts               typed defineTable models (builder-native feeds)
    rising.ts               pure score model + recompute CTEs
    activity.ts             recordPostActivity — the recording CTE
    queries.ts              getNewFeed + getRisingFeed (both .keyset())
    seed.ts                 deterministic posts + activity at DEMO_NOW
    migrate.ts              applies the .sql file via @sisal/migrate splitter
    main.ts                 the demo
```
