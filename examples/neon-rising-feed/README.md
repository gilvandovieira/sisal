# Neon rising feed (Sisal example)

A focused database/feed example: a Reddit-style **rising** timeline on **Neon /
PostgreSQL** using [Sisal](../../README.md). It proves **time-bucketed
activity**, a **moving-window** ranking, a **stored `rising_score`**, and
**keyset pagination** — all in a shape that stays **Deno Deploy / Neon
serverless** friendly.

It is **not** a Reddit clone — no auth, no HTTP server, no comments tree, no
communities, no moderation UI, no frontend, no background worker. Just: posts,
activity buckets, a moving-window score, `/new` + `/rising` timelines, and the
places where Sisal needs a raw-SQL escape hatch.

> There is a sibling example, [`libsql-rising-feed`](../libsql-rising-feed/),
> that builds the **same** feed on libSQL/Turso (SQLite). Reading them side by
> side is the point: SQLite has no stored procedures, so logic that is one
> database call here becomes a TypeScript transaction there. See
> [Sisal API pressure points](#sisal-api-pressure-points).

## What this example proves

1. Sisal models posts + time-bucketed activity and runs against Neon/Postgres
   with the same API as `@sisal/pg`.
2. A **moving-window** ranking ("what is gaining attention _right now_") can be
   built from pre-aggregated 5-minute activity buckets, **stored** in an indexed
   `rising_score`, and recomputed cheaply.
3. The whole multi-step activity recorder is **one atomic database call**
   (`app.record_post_activity`) — no interactive transaction callback holding a
   connection open.
4. `/rising` is paginated with **keyset (cursor)** pagination over a computed
   score, builder-native.
5. Where Sisal's fluent builder isn't enough (time buckets, moving-window
   aggregates, function bodies), the **raw-SQL escape hatch** is clean and
   parameterized — and those gaps are documented, not hidden.

## What is a moving average (in small words)

Instead of asking "how many votes total, ever?", a moving average asks "how much
is happening **lately**?" You slice time into small windows, count activity in
each, and add up the **recent** windows — older windows quietly drop off the
back. A post that got 1,000 votes yesterday but nothing in the last hour has a
**low** moving average; a post getting 30 votes _right now_ has a **high** one.
That is what makes a feed feel like it is "rising."

## Important product distinction

Keep these three feeds separate — they answer different questions:

- **`/new`** — _newest content_. Order by `created_at`. No scoring.
- **`/hot`** — _good and recent_. A score that is roughly **stable** for a given
  (votes, age) pair; see the sibling [`neon-hot-feed`](../neon-hot-feed/).
- **`/rising`** — _gaining attention right now_. A **time-dependent**
  moving-window score over recent activity.

This example is **only** about `/rising` (and `/new` for contrast). It does
**not** mix in `/hot` — that is a different example on purpose.

## Why `/rising` needs time-bucketed activity

To know what is rising you need "how much happened in the last 15 / 60 minutes?"
Answering that by scanning every individual vote/comment/report on every read
does not scale. So activity is **pre-aggregated into 5-minute buckets**
(`post_activity_buckets`): each event bumps a counter in the current bucket. A
moving-window score is then a small **sum over a handful of recent buckets**,
not a scan over all history.

### Why 5-minute buckets

5 minutes is a product trade-off: small enough that "the last 15 minutes" has
real resolution (three buckets), large enough that a busy post writes a handful
of bucket rows per hour instead of one row per event. Tune it for your traffic.

## Why `rising_score` is stored (not computed per request)

Computing the moving window for **every** post on **every** request would
re-scan buckets constantly and can't be indexed for an ordered feed. Instead we
**store** the result in `posts.rising_score` and index it
(`posts_rising_feed_idx`), so the feed is an ordered, keyset-paginated index
scan. The score is refreshed by an explicit **recompute**
(`deno task
recompute`, a cron, or right after recording activity) — no
background worker is required for the example to work.

## Why `rising_score` is time-dependent (and why `p_now` is explicit)

A hot score is roughly stable: the same (votes, age) always yields the same
value. A **rising** score is **not** — it depends on _when you ask_, because
"the last 15 minutes" slides forward with the clock. The same post is rising at
12:00 and cold at 13:30 with no new activity at all.

Because of that, every scoring function takes the reference time **`p_now` as an
explicit argument** instead of reading `now()` inside an `IMMUTABLE` function:

- it makes seeding and tests **deterministic** (same data + same `p_now` ⇒ same
  scores);
- it makes the time-dependence **explicit** in the API;
- `app.calculate_rising_score` is therefore `STABLE` (it reads tables and
  depends on `p_now`), never `IMMUTABLE`.

The TypeScript mirror in `src/rising.ts` follows the same rule: it takes `now`
and never reads the wall clock.

## How the activity weights work

Each event bumps one counter; a bucket's `activity_score` is a weighted sum
(constants live in `app.bucket_activity_score` and `src/rising.ts`):

| Event          | Weight | Why                                         |
| -------------- | -----: | ------------------------------------------- |
| `upvote`       |   `+1` | baseline positive signal                    |
| `downvote`     | `-0.5` | mild negative                               |
| `comment`      |   `+3` | writing > clicking; real engagement         |
| `unique actor` |   `+2` | breadth of people, counted once per bucket  |
| `report`       |   `-8` | strong negative; a spike should sink a post |

These are **product tuning, not universal truth** — change them to fit your app.

### How unique-actor counting reduces spam

`unique_actors` only grows on an actor's **first** touch in a bucket (tracked in
`post_activity_actors` with `ON CONFLICT DO NOTHING`). So ten different people
each upvoting once → `+10` upvotes **and** `+10×2` unique-actor weight; one
person clicking ten times → `+10` upvotes but only `+1×2`. Breadth beats volume,
which is exactly what you want a "rising" signal to reward.

### Why reports penalize the rising score

`report` carries a large negative weight (`-8`), so a burst of reports drives a
bucket's `activity_score` negative, which pulls every moving-window term down. A
post being flagged stops rising fast — useful both for feeds and for spotting
report spikes (see [Where moving averages help](#where-moving-averages-help)).

## The rising-score model

Over the per-bucket `activity_score`, at reference time `p_now`:

```
last_15m = Σ activity_score over [p_now-15m,  p_now]
last_60m = Σ activity_score over [p_now-60m,  p_now]
prev_60m = Σ activity_score over [p_now-120m, p_now-60m)
accel    = max(last_15m - prev_60m / 4, 0)     # heating up vs. the prior hour
rising   = last_15m*3 + last_60m + accel*2
```

`last_15m` dominates (recency matters most), `last_60m` adds broader context,
and `accel` rewards a post accelerating now versus the previous hour's pace
(`prev_60m / 4` puts the prior hour on the same 15-minute footing). Reports are
already negative inside `activity_score`, so they drag every term down.

## How keyset pagination works for `/rising`

`/rising` orders by `rising_score DESC, rising_score_updated_at DESC, id DESC`
and filters `rising_score > 0`. The page boundary is a **keyset** over those
three columns, not an `OFFSET`:

```sql
WHERE status = 'published' AND rising_score > 0
  AND (rising_score, rising_score_updated_at, id)
    < (:rising_score, :rising_score_updated_at, :id)
ORDER BY rising_score DESC, rising_score_updated_at DESC, id DESC
LIMIT :limit
```

This is built with Sisal's `.keyset({ orderBy, after, form: "row-value" })`
(`src/queries.ts`); the first page omits the `after` cursor. Ending the order on
the unique `id` makes the keyset a **total order**, so pages never overlap or
skip — even when scores tie. Keyset stays cheap at any depth and doesn't shift
when rows change between requests.

## How to run

Prerequisites: [Deno](https://deno.com/) 2.x and a Neon project (any tier).

```sh
cd examples/neon-rising-feed
cp .env.example .env          # then edit .env with your Neon URLs

deno task migrate             # create tables, indexes, and functions
deno task seed                # insert 24 deterministic posts + activity
deno task demo                # print /new and /rising, boost a post, repaginate
```

`deno task demo` is self-contained: it migrates idempotently and reseeds at a
fixed `DEMO_NOW`, so it also works on a fresh database. Start clean with:

```sh
deno task demo -- --reset
```

### Reset / reseed / recompute

```sh
deno task reset               # DROP tables + schema app, then re-migrate
deno task seed                # reinsert deterministic demo data
deno task recompute           # recompute stored rising scores (at real now())
```

`--reset` is destructive (drops `posts`, the activity tables, and `schema app`).
Point it at a scratch Neon branch, never production. Because `rising_score` is
time-dependent, `deno task recompute` recomputes at the **real** clock — so
right after a fresh `seed` (pinned to `DEMO_NOW`) it will zero out scores, which
is the expected behavior. The demo always recomputes at `DEMO_NOW` for stable
output.

### Environment variables

- `DATABASE_URL` — app/runtime queries. For Neon, prefer the **pooled** URL.
- `DATABASE_DIRECT_URL` — migrations/admin work; falls back to `DATABASE_URL`.

## Important Neon note

Neon fully supports transactions; the practical constraint is the **execution
mode**. Neon HTTP mode is excellent for **single statements / non-interactive**
operations (one round trip, no session held open) — ideal for Deno Deploy.
**Interactive transaction callbacks** (`db.transaction(tx => { read; write })`)
need a session held open across round trips, which fights the stateless model.

So this example pushes the multi-step activity recorder into **one database
function call** (`app.record_post_activity`) and recomputes scores with **single
statements** / `db.batch`, never an interactive callback. (The libSQL sibling
_has_ to use an interactive transaction, because SQLite has no functions — a
great illustration of the trade-off.)

## What's Sisal-native and what's raw SQL

**Sisal-native (the fluent API was enough):**

- Typed table models — `defineTable` with columns, defaults, FKs, composite PKs,
  and **DESC index** metadata via the v0.4.0 rich-index DDL (`src/schema.ts`).
- Inserts — `db.insert(posts).values(...)` (`src/seed.ts`).
- **Both feeds** — `/new` and `/rising` via `.keyset({ orderBy, after })`
  (expanded and row-value forms), including `nextCursor` (`src/queries.ts`).
- The **typed function calls** — `defineFunction(...)` + `db.call(...).one()`
  render `select * from app.fn($1::uuid, …)` with casts from the argument column
  types and a typed result row, no raw `sql` string (`src/activity.ts`,
  `src/recompute.ts`).
- **Temporal dates (default), with a `Date` fallback** — timestamp columns use
  `columns.timestamp({ withTimezone: true })`, which Sisal infers as
  `Temporal.Instant`; `src/db.ts` opens with `temporal: { parse: true }` so
  reads (feed rows, cursors, `db.call` results) come back as `Temporal.Instant`.
  The scoring helpers in `src/rising.ts` accept `Temporal.Instant | Date`
  (`TimeInput`) and `toInstant(...)` converts the `Date` fallback at the
  `db.call` edge. (The libSQL sibling keeps ISO-string `TEXT` — SQLite has no
  native timestamp type, so the `Date`/string form is its natural fallback.)
- `db.$count`, and parameterized one-off lookups via the `sql` tag.

**Raw-SQL escape hatches (parameterized, isolated, justified):**

- **`CREATE FUNCTION` migrations** — `app.bucket_5m`,
  `app.bucket_activity_score`, `app.record_post_activity`,
  `app.calculate_rising_score`, `app.recompute_*` (`migrations/0002…0004`).
  Sisal's snapshot DDL generator emits only additive table/column DDL.
- **The moving-window aggregate** —
  `sum(activity_score) FILTER (WHERE
  bucket_start >= p_now - interval '15 minutes')`
  inside `app.calculate_rising_score`. Sisal's builder has aggregates but no
  `FILTER` clause and no interval arithmetic.
- **The migration runner** — reads each `.sql` file and applies it one statement
  at a time via `splitSqlStatements` (shared from `@sisal/migrate`).

## Sisal API pressure points

Honest gaps this example hit. Several v0.4.0 features it _relies_ on (typed
function caller, keyset pagination, `sql` in `SET`/`VALUES`, `db.batch`, column
naming) are exactly the items the [hot-feed example](../neon-hot-feed/)
motivated — this one builds on them and surfaces the next layer:

1. **No stored functions/triggers in the snapshot DDL.** Four of this example's
   five migrations are `CREATE FUNCTION` bodies that Sisal cannot generate, so
   the `.sql` files are the source of truth and `src/schema.ts` is a typed
   mirror. Tracked as **v0.5.0 roadmap item 7** (functions & triggers DDL).
2. **No `FILTER`-clause aggregates and no interval/date math in the builder.**
   The moving-window sums
   (`sum(...) FILTER (WHERE bucket_start >= now -
   interval '15 minutes')`)
   cannot be expressed with `sum()` + `where`, so the score query is raw SQL. A
   `filter`-aware aggregate and an interval helper would let this stay
   builder-native.
3. **No portable time-bucket helper.** `app.bucket_5m` (PG) and `bucket5m` (TS,
   for SQLite) are hand-written per dialect. A Sisal `dateTrunc`/bucket helper
   that renders per dialect would remove the duplication.
4. **`db.call` is Postgres-family only.** The typed function caller is the
   cleanest part of this example — and it does **not** exist for SQLite/libSQL,
   because there are no SQL functions to call. The libSQL sibling has to
   reimplement the whole recorder in TypeScript. This is a genuine dialect
   divergence (v0.5.0 roadmap item 4/5) — but Sisal could offer a **portable
   "transaction script"** abstraction so the application code reads the same on
   both engines.
5. **`UPDATE … FROM (subquery)` still has no builder surface.** Carried over
   from the hot-feed example; the bulk recompute lives inside a SQL function
   here, sidestepping it.
6. **`.optional()` widens the SELECT row type.** Marking a nullable column
   `.optional()` (insert-only) added `undefined` to its inferred **select**
   type, which contradicts its documented "insert-only" intent. We worked around
   it by keeping `rising_score_updated_at` required-on-insert and passing an
   explicit `null` (see `src/schema.ts`). Worth tightening so `.optional()`
   affects only the insert type.

## Where moving averages help

The same pattern — bucket events in time, sum recent windows, store the result —
shows up far beyond social feeds:

- **Social feeds:** rising posts, active discussions, trending communities.
- **Moderation:** report spikes, suspicious vote bursts, sudden activity from
  brand-new accounts.
- **Course platforms:** lessons with rising engagement, or rising
  confusion/comments (a spike of questions on one lesson).
- **E-commerce:** products suddenly getting purchases, views, or wishlist adds.
- **Observability:** rising error rates, latency spikes, throughput changes.
- **Analytics:** trend detection that reacts to a _sustained shift_ without
  overreacting to a single event.

## Production notes

This example keeps the recompute path deliberately simple. A few things you'd do
differently at scale (kept out to stay focused):

- **Don't recompute every post forever.** `recompute_all_rising_scores` rescans
  every published post. In production, recompute only **dirty** posts — those
  with activity since their last `rising_score_updated_at` — e.g. drive it from
  a small queue/`dirty` flag set by `record_post_activity`, or scan
  `post_activity_buckets` for buckets newer than the last recompute.
- **Old buckets need retention.** Once a bucket is older than the 120-minute
  window it can never affect a rising score again. Periodically delete or roll
  up buckets past the window (a daily job, or partition-by-day + drop), so
  `post_activity_buckets` doesn't grow without bound.

> Adapter note: this example runs on **`@sisal/neon`**, which returns
> `double precision` as a JS `number`, so `rising_score` is a real number
> end-to-end. If you point it at plain PostgreSQL via **`@sisal/pg`** instead,
> that adapter currently returns `double precision` as a **string** (integers
> come back as numbers), so `rising_score.toFixed(...)` would throw and
> client-side numeric sorts would be lexicographic — `Number(...)`-coerce those
> values until the adapter is fixed. Tracked in the
> [v0.5.0 roadmap](../../docs/v0.5.0-roadmap.md) (item 11).

## Tests

```sh
# network-free unit tests (the rising-score model + the SQL splitter)
deno task test

# database-backed integration test — RESETS the target DB; use a scratch branch
SISAL_NEON_RISING_FEED_IT=1 \
  DATABASE_URL="postgres://user:pw@ep-xxx.neon.tech/db?sslmode=require" \
  deno test -A feed_db_test.ts
```

- `rising_test.ts` (network-free): `bucket5m`, `bucketActivityScore`,
  `calculateRisingScore` (recency weighting + time-decay), the statement
  splitter, and that both feeds render valid Postgres SQL driverlessly.
- `feed_db_test.ts` (gated by `SISAL_NEON_RISING_FEED_IT=1` + `DATABASE_URL`):
  bucket creation, unique-actor dedup, weight ordering (comments > upvotes;
  reports penalize), stored `rising_score` matching the TypeScript model,
  `/rising` ordering, keyset pagination without duplicates, moving-window decay
  as `p_now` advances, and deterministic scoring.

## Files

```
examples/neon-rising-feed/
  README.md
  deno.json                 tasks + JSR imports
  .env.example              DATABASE_URL + DATABASE_DIRECT_URL
  mod.ts                    entrypoint; re-exports + runs the demo
  rising_test.ts            network-free unit tests
  feed_db_test.ts           gated database integration test
  migrations/
    0001_init.sql                 tables + DESC keyset indexes
    0002_bucket_functions.sql     app.bucket_5m (IMMUTABLE)
    0003_activity_functions.sql   weights + app.record_post_activity (atomic)
    0004_rising_score_functions.sql  calculate / recompute rising scores
  src/
    db.ts                   runtime vs admin connections
    schema.ts               typed defineTable models (builder access)
    rising.ts               TypeScript mirror of the scoring model
    activity.ts             recordPostActivity → app.record_post_activity
    queries.ts              getNewFeed + getRisingFeed (both .keyset())
    recompute.ts            recompute one / all rising scores (typed db.call)
    seed.ts                 deterministic posts + activity at DEMO_NOW
    migrate.ts              applies .sql files via @sisal/migrate splitter
    main.ts                 the demo
```
