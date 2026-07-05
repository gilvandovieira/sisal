# PostgreSQL-family hot feed (Sisal example)

A focused database/feed example: a Reddit-style **hot feed** on the PostgreSQL
family (`@sisal/pg` / `@sisal/neon`) using [Sisal](../../README.md), built to
respect **Deno Deploy / Neon serverless** constraints.

**How this differs from
[`postgres-family-feed`](../postgres-family-feed/README.md):** that example is
the `/rising` **velocity** feed — a time-dependent score recomputed from moving
windows on a schedule. This one is the `/hot` feed — a score that is **stable in
`(score, created_at)`** (never reads `now()`), so it is stored, indexed, and
recomputed **only inside the vote**, and the vote itself is **one atomic
database call** with no interactive transaction (the serverless angle). For the
declarative analytics take on velocity, see
[`postgres-family-analytics`](../postgres-family-analytics/README.md).

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
(`src/hot.ts` and the `app.calculate_hot_score` function in `src/schema.ts`):

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
  keyset is `(created_at, id)` (`src/queries.ts → getNewFeed`).
- `/hot` orders by `hot_score desc, created_at desc, id desc` — a _computed_
  ranking column. The three-part keyset over a `double precision` column
  (`src/queries.ts → getHotFeed`).

Both are built with Sisal's `.keyset({ orderBy, after })` helper: `/new` uses
the default expanded `or`/`and` predicate and `/hot` the row-value form
(`(hot_score, created_at, id) < (…)`). Both use **keyset (cursor) pagination,
never `OFFSET`**, so deep pages stay cheap and pages don't shift when rows are
inserted between requests.

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
| **Non-interactive transaction** (`db.batch([...])`)                          | one\*       | no                              | good                        |
| **Single-statement atomic mutation** (one data-modifying CTE)                | one         | no                              | good                        |
| **Database function** (`select * from app.vote_post(…)`)                     | one         | no                              | **preferred here**          |

The **non-interactive transaction** is now first-class as `db.batch([...])`: it
submits several pre-built statements as one atomic unit — no `tx => {...}`
callback holding a connection open. The statements commit together and roll back
on any failure, but none may read a previous one's result (use the database
function or an interactive transaction for that):

```ts
await db.batch([
  db.insert(postVotes).values({ postId, userId, value }),
  db.update(posts).set({
    score: sql`${posts.columns.upvotes} - ${posts.columns.downvotes}`,
  })
    .where(eq(posts.columns.id, postId)),
]); // atomic, non-interactive
```

This example still uses the **database function** `app.vote_post` for the vote
(it needs to read the prior vote before writing), and a **single-statement**
`UPDATE … FROM` for the bulk recompute. `db.batch` is the right tool when the
writes are independent. _\*One round trip on drivers with a native batch; an
atomic `begin; …; commit` otherwise._

## How to run

Prerequisites: [Deno](https://deno.com/) 2.x and a Neon project (any tier).

```sh
cd examples/postgres-family-hot-feed
cp .env.example .env          # then edit .env with your Postgres/Neon URLs

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
- **Both feeds** — `/new` and `/hot` are built with
  `.keyset({ orderBy, after })` (the expanded `or`/`and` form and the row-value
  form respectively), including the `nextCursor` derivation, with no raw SQL
  (`src/queries.ts`).
- The **typed `app.vote_post` call** — `defineFunction(...)` +
  `db.call(...).one()` renders
  `select * from app.vote_post($1::uuid, $2::uuid, $3::smallint)` with the casts
  taken from the argument column types and a typed result row, no raw `sql`
  string (`src/vote.ts`).
- `db.$count`, and parameterized one-off lookups via the `sql` tag.

**Raw-SQL escape hatches (parameterized, isolated, justified):**

- **The two `CREATE FUNCTION` bodies** — `app.calculate_hot_score` and
  `app.vote_post` are raw PL/pgSQL, but they now live in `src/schema.ts` as
  `schemaObjects` (a v0.5.0 capability), so they are part of the typed schema
  and the generated migration, not separate hand-written `.sql` files.
- **The bulk recompute** — a data-modifying `UPDATE … FROM (… LEFT JOIN …)` that
  calls the hot-score function in its `SET` clause
  (`src/seed.ts → recomputeAggregates`).
- **The migration runner** — `src/migrate.ts` **generates** the full init DDL
  from `src/schema.ts` (`generatePostgresUpStatements`) and applies it one
  statement at a time (the Neon driver sends one statement per call).

## Sisal API pressure points

Honest gaps this example ran into. Each is a candidate for future Sisal work.
Several have since landed in v0.4.0: the **typed database-function caller**
(`defineFunction` / `db.call`, now used by `src/vote.ts`), **keyset pagination**
(`.keyset({ orderBy, after })`, now used by both feeds in `src/queries.ts`),
**column-name mapping** (the default `snake_case` naming strategy, so
`src/schema.ts` could use camelCase keys without changing the SQL), the
**serverless-safe migration applier** (`splitSqlStatements` is now exported from
`@sisal/migrate`, the migrator has a `splitStatements` apply mode, and the
`sisal` CLI has a `provider: "neon"` target — `src/migrate.ts` uses the shared
splitter), and **raw `sql` in `.set()` / `.values()`** (a scalar `sql`
expression is now a valid column value).

1. **Snapshot DDL expresses this whole schema — resolved (v0.4.0 → v0.5.0).**
   `generatePostgresUpStatements` now emits **DESC index ordering** (rich
   indexes), the value **CHECK**, `gen_random_uuid()` / `now()` **server
   defaults**
   (`.default(sql\`…\`)`), and the two **functions** (carried as`schemaObjects`). So`src/schema.ts`is the single source of truth and`src/migrate.ts`generates the full init from it — there are no hand-written`.sql`files. (Drop/`down`
   generation and drift over opaque function bodies are tracked separately.)
2. **`UPDATE … FROM` / `INSERT … SELECT` now have a builder — resolved (v0.5).**
   v0.5 shipped **mutation joins** (`update(t).from(source)` renders
   `UPDATE … FROM`) and **`insert(t).select(query)`**, both demonstrated
   builder-native by the sibling
   [`postgres-family-feed`](../postgres-family-feed/README.md)
   (`db.with(...).update(posts).from(computedScore)`). So the surface this
   example once called missing exists today. The bulk `recomputeAggregates` here
   stays a single raw statement for a **narrower** reason: its `FROM` is a
   `posts base LEFT JOIN (aggregate subquery)` joined source, and
   `.from(source)` takes **one** relation — so the builder-native form is to
   lift the LEFT-JOIN aggregate into a CTE and `update(posts).from(thatCte)`,
   with scalar `sql` in `.set()` calling `app.calculate_hot_score(...)` (both
   already valid since v0.5). That is exactly the refactor the CTE sibling
   already performed; this example keeps the one raw `UPDATE … FROM (subquery)`
   on purpose, as the documented clean escape hatch.

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
examples/postgres-family-hot-feed/
  README.md
  deno.json                 tasks + JSR imports
  .env.example              DATABASE_URL + DATABASE_DIRECT_URL
  mod.ts                    entrypoint; re-exports + runs the demo
  hot_test.ts               network-free unit tests
  feed_db_test.ts           gated database integration test
  src/
    db.ts                   runtime vs admin connections
    schema.ts               typed models + functions (single source of truth)
    hot.ts                  TypeScript mirror of the hot-score model
    migrate.ts              generates the init DDL from schema.ts and applies it
    queries.ts              getNewFeed + getHotFeed (both .keyset())
    vote.ts                 votePost → app.vote_post (single statement)
    seed.ts                 demo data + bulk recompute
    main.ts                 the demo
```

## Future Sisal features this example could motivate

These gaps are written up in full — with proposed APIs, affected packages, and
acceptance criteria — in the [v0.4.0 roadmap](../../docs/v0.4.0-roadmap.md).

- **`UPDATE … FROM` / `INSERT … SELECT`** — **landed in v0.5** (mutation joins +
  `insert().select()`; see the sibling
  [`postgres-family-feed`](../postgres-family-feed/README.md)). The
  join-in-`FROM` derived table here could move onto a CTE +
  `update(posts).from(cte)`; it stays raw only as the documented escape-hatch
  demo (see pressure point 2 above).
- **Richer DDL generation**: DESC/partial/expression indexes, CHECK constraints,
  and (eventually) functions/triggers in the snapshot pipeline.

**Landed in v0.4.0** (this example now uses them): a **typed database-function
caller** (`defineFunction` / `db.call`, see `src/vote.ts`), **keyset
pagination** (`.keyset({ orderBy, after })`, see `src/queries.ts`),
**column-name mapping** (the default `snake_case` naming strategy), a
**serverless-safe migration applier** (`splitSqlStatements` from
`@sisal/migrate`, the migrator's `splitStatements` mode, and the CLI's
`provider: "neon"` target; `src/migrate.ts` uses the shared splitter), and **raw
`sql` in `.set()` / `.values()`** (a scalar `sql` expression is now a valid
column value).
