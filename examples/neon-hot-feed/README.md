# Neon hot feed (Sisal example)

A focused database/feed example: a Reddit-style **hot feed** on **Neon /
PostgreSQL** using [Sisal](../../README.md), built to respect **Deno Deploy /
Neon serverless** constraints.

It is **not** a Reddit clone — no auth, no HTTP server, no comments, no
communities, no moderation, no frontend. Just: posts, votes, a `/new` timeline,
a `/hot` timeline, an atomic vote mutation, and the places where Sisal needs a
raw-SQL escape hatch.

## What this example proves

1. Sisal models posts and votes and runs against Neon/Postgres with the same API
   as `@sisal/pg`.
2. A `/new` timeline (newest first) is trivial; a `/hot` timeline needs a
   **ranking value**, and that value can be **stored and indexed**.
3. A multi-step vote (read previous vote → upsert/delete → recompute totals and
   hot score) can be done as **one atomic database call**, with **no interactive
   transaction callback** — which is what makes it Deno-Deploy / Neon-HTTP
   friendly.
4. Where Sisal's fluent builder isn't enough, the **raw-SQL escape hatch** is
   clean and parameterized — and those gaps are documented, not hidden.

## Why a hot feed needs a stored `hot_score`

A naive "hot" score is `score / age` — but `age` changes every second, so the
ranking of _every_ post drifts continuously and you would have to recompute and
re-sort the whole table on every read. That does not scale and cannot be
indexed.

This example uses a **Reddit-inspired, time-anchored** model instead
(`src/hot.ts` and `migrations/0002_hot_score_function.sql`):

```
order = log10(max(|score|, 1))
sign  = +1 if score > 0, -1 if score < 0, else 0
age   = (epoch_seconds(created_at) - HOT_EPOCH_SECONDS) / HOT_DECAY_SECONDS
hot   = sign * order + age
```

with `HOT_EPOCH_SECONDS = 1704067200` (2024-01-01Z) and
`HOT_DECAY_SECONDS = 45000` (~12.5h). Because `hot` depends **only** on `score`
and `created_at` — never on `now()` — it is **stable for a given post** and only
changes when the vote totals change. So we:

- store it in `posts.hot_score`,
- recompute it **only** inside `app.vote_post` when a vote changes the score,
- and index it (`posts_hot_feed_idx`) for an ordered, keyset-paginated scan.

The PostgreSQL function `app.calculate_hot_score` is marked **`IMMUTABLE`**:
`extract(epoch from timestamptz)` is the absolute seconds since the Unix epoch
and is independent of the session time zone, so the function is genuinely
deterministic and safe to index.

## Why `/new` is simple and `/hot` needs ranking

- `/new` orders by `created_at desc, id desc` — a column that never changes. The
  keyset is `(created_at, id)`, expressible directly with Sisal's builder
  (`src/queries.ts → getNewFeed`).
- `/hot` orders by `hot_score desc, created_at desc, id desc` — a _computed_
  ranking column. The three-part keyset over a `double precision` column reads
  more clearly as a raw `sql` template (`src/queries.ts → getHotFeed`).

Both use **keyset (cursor) pagination, never `OFFSET`**, so deep pages stay
cheap and pages don't shift when rows are inserted between requests.

## Important Neon note

**Neon Free is not the problem, and Neon is not missing transactions.** Neon
fully supports transactions. The practical constraint is the **execution mode**:

- **Neon HTTP mode** is excellent for **single queries** and **non-interactive
  operations**. One statement, one round trip, no session held open — ideal for
  Deno Deploy and other stateless/serverless runtimes.
- **Interactive transaction callbacks** — `db.transaction(async (tx) => { … })`
  with several awaited statements inside — need a **WebSocket / client-style
  connection** that stays open across round trips. That is fine for a
  long-running server, but it is an awkward default on Deno Deploy + Neon: it
  ties up a connection for the whole callback and fights the stateless model.

So for Deno-Deploy-friendly code, **prefer single atomic SQL statements,
non-interactive transactions, or database functions** for multi-step mutations.

### Four ways to make a multi-step change atomic

| Approach                                                                     | Round trips | Holds a session open?           | Good on Deno Deploy + Neon? |
| ---------------------------------------------------------------------------- | ----------- | ------------------------------- | --------------------------- |
| **Interactive transaction** (`db.transaction(tx => { read; write; write })`) | several     | **yes**, for the whole callback | least preferred             |
| **Non-interactive transaction** (one batched `begin; …; commit`)             | one         | briefly                         | ok                          |
| **Single-statement atomic mutation** (one data-modifying CTE)                | one         | no                              | good                        |
| **Database function** (`select * from app.vote_post(…)`)                     | one         | no                              | **preferred here**          |

This example uses the **database function** `app.vote_post` (preferred) and, in
`src/seed.ts`, a **single-statement** data-modifying `UPDATE … FROM` for the
bulk recompute. It deliberately avoids a long `db.transaction` callback for the
vote path. The driver _can_ do interactive transactions (the seed/test reset
even uses small ones), but they are not the shape this example optimizes for.

## How to run

Prerequisites: [Deno](https://deno.com/) 2.x and a Neon project (any tier).

```sh
cd examples/neon-hot-feed
cp .env.example .env          # then edit .env with your Neon URLs

deno task migrate             # create tables, indexes, and functions
deno task seed                # insert ~24 posts + votes
deno task demo                # print /new, /hot, vote, then /hot again
```

`deno task demo` is self-contained: it applies migrations idempotently and seeds
if the database is empty, so `deno task demo` alone also works on a fresh
database. Run it with `--reset` to start clean:

```sh
deno task demo -- --reset
```

The raw commands (if you prefer not to use the tasks) are just
`deno run --env-file=.env --allow-env --allow-net --allow-read src/<file>.ts`.

### Reset and reseed

```sh
deno task reset               # DROP tables + schema app, then re-migrate
deno task seed                # reinsert demo data
# or in one step:
deno task demo -- --reset
```

`--reset` is destructive (it drops `posts`, `post_votes`, and `schema app`).
Point it at a scratch Neon branch, never production.

### Environment variables

- `DATABASE_URL` — app/runtime queries. For Neon, prefer the **pooled** URL
  (host contains `-pooler`).
- `DATABASE_DIRECT_URL` — migrations/admin work. The **direct** (non-pooled) URL
  is commonly preferred for migrations; falls back to `DATABASE_URL` if unset.

## What's Sisal-native and what's a raw-SQL escape hatch

**Sisal-native (the fluent API was enough):**

- Typed table models — `defineTable` with columns, defaults, FK, composite PK,
  CHECK, and index metadata (`src/schema.ts`).
- Inserts — `db.insert(posts).values(…)`, `db.insert(postVotes).values(…)`
  (`src/seed.ts`).
- The **`/new` feed**, including its `(created_at, id)` keyset predicate, built
  entirely with `select / where / and / or / lt / eq / orderBy / limit`
  (`src/queries.ts → getNewFeed`).
- The **typed `app.vote_post` call** — `defineFunction(...)` +
  `db.call(...).one()` renders
  `select * from app.vote_post($1::uuid, $2::uuid, $3::smallint)` with the casts
  taken from the argument column types and a typed result row, no raw `sql`
  string (`src/vote.ts`).
- `db.$count`, and parameterized one-off lookups via the `sql` tag.

**Raw-SQL escape hatches (parameterized, isolated, justified):**

- **`CREATE FUNCTION` migrations** — `app.calculate_hot_score` and
  `app.vote_post` (`migrations/0002…`, `0003…`). Sisal's snapshot DDL generator
  emits only additive table/column DDL.
- **The `/hot` feed** — a raw `sql` template for the three-column keyset over
  the computed `hot_score` column (`src/queries.ts → getHotFeed`).
- **The bulk recompute** — a data-modifying `UPDATE … FROM (… LEFT JOIN …)` that
  calls the hot-score function in its `SET` clause
  (`src/seed.ts →
  recomputeAggregates`).
- **The migration runner** — a small dollar-quote-aware statement splitter
  (`src/sql_split.ts`), because the Neon driver sends one statement per call.

## Sisal API pressure points

Honest gaps this example ran into. Each is a candidate for future Sisal work.
Two have since landed in v0.4.0: the **typed database-function caller**
(`defineFunction` / `db.call`, now used by `src/vote.ts`) and **column-name
mapping** (the default `snake_case` naming strategy, so `src/schema.ts` could
use camelCase keys without changing the SQL).

1. **No serverless-safe raw-SQL migration runner.** A `.sql` file holds several
   statements, but the Neon driver (extended protocol) allows one per call, and
   splitting on `;` breaks `$$ … $$` function bodies. We hand-rolled
   `splitSqlStatements`. Sisal could ship a serverless-safe SQL migration
   applier (and the `sisal` CLI currently targets `postgres`/`sqlite` adapters,
   not a Neon-HTTP applier).
2. **Snapshot DDL can't express this schema.** `generatePostgresUpStatements`
   emits additive `CREATE TABLE` / `ADD COLUMN` only — no **DESC index
   ordering**, no functions, no triggers, no partial/expression indexes. So the
   `.sql` migrations are the source of truth and `src/schema.ts` is a _typed
   mirror_ for the builder, not the generator's output.
3. **No keyset-pagination helper.** Every feed re-implements the
   `(a, b, c) < (x, y, z)` keyset by hand. A `keyset({ orderBy, after })` helper
   (emitting either nested `or`/`and` or a row-value comparison) would make
   `/hot` builder-native. Related: timestamp **precision** at page boundaries —
   a JS `Date` cursor is millisecond precision while `timestamptz` is
   microsecond, so a keyset helper should standardize comparison precision.
4. **No SQL-function expressions in builder `SET`/`VALUES`.** We can't write
   `set hot_score = app.calculate_hot_score(…)` or insert with a computed
   default through the builder, so the bulk recompute is raw SQL.

## Tests

```sh
# network-free unit tests (the hot-score model + the SQL splitter)
deno task test

# database-backed integration test — RESETS the target DB; use a scratch branch
SISAL_NEON_HOT_FEED_IT=1 \
  DATABASE_URL="postgres://user:pw@ep-xxx.neon.tech/db?sslmode=require" \
  deno test -A feed_db_test.ts
```

- `hot_test.ts` (network-free): `calculateHotScore` sign/age/monotonicity, the
  statement splitter, and that both feeds build & render valid Postgres SQL
  against a driverless database.
- `feed_db_test.ts` (gated by `SISAL_NEON_HOT_FEED_IT=1` + `DATABASE_URL`):
  `app.vote_post` create / switch / remove, aggregate consistency
  (`score == upvotes - downvotes`, counts match `post_votes`), stored
  `hot_score` matching the TypeScript model, stable hot ordering, and keyset
  pagination producing no duplicates across pages.

## Files

```
examples/neon-hot-feed/
  README.md
  deno.json                 tasks + JSR imports
  .env.example              DATABASE_URL + DATABASE_DIRECT_URL
  mod.ts                    entrypoint; re-exports + runs the demo
  hot_test.ts               network-free unit tests
  feed_db_test.ts           gated database integration test
  migrations/
    0001_init.sql           tables, indexes, CHECK
    0002_hot_score_function.sql   app.calculate_hot_score (IMMUTABLE)
    0003_vote_post_function.sql   app.vote_post (atomic mutation)
  src/
    db.ts                   runtime vs admin connections
    schema.ts               typed defineTable models (builder access)
    hot.ts                  TypeScript mirror of the hot-score model
    sql_split.ts            dollar-quote-aware statement splitter
    migrate.ts              serverless-safe migration runner
    queries.ts              getNewFeed (builder) + getHotFeed (raw sql)
    vote.ts                 votePost → app.vote_post (single statement)
    seed.ts                 demo data + bulk recompute
    main.ts                 the demo
```

## Future Sisal features this example could motivate

These gaps are written up in full — with proposed APIs, affected packages, and
acceptance criteria — in the [v0.4.0 roadmap](../../docs/v0.4.0-roadmap.md).

- A **keyset/cursor pagination helper** with precision-aware comparisons.
- A **serverless-safe SQL migration applier** (splitting +
  one-statement-per-call execution) and a Neon target for the `sisal` CLI.
- **Raw expressions in `SET` / `VALUES` / `DEFAULT`** (e.g. calling a SQL
  function or `now()` in a builder mutation).
- **Richer DDL generation**: DESC/partial/expression indexes, CHECK constraints,
  and (eventually) functions/triggers in the snapshot pipeline.

**Landed in v0.4.0** (this example now uses them): a **typed database-function
caller** (`defineFunction` / `db.call`, see `src/vote.ts`) and **column-name
mapping** (the default `snake_case` naming strategy).
