# libSQL / Turso rising feed (Sisal example)

The **SQLite** counterpart to [`neon-rising-feed`](../neon-rising-feed/). It
builds the **same** Reddit-style `/rising` timeline — time-bucketed activity, a
moving-window score, a stored `rising_score`, and keyset pagination — on
**libSQL / Turso** with [Sisal](../../README.md).

Read the [Neon README](../neon-rising-feed/README.md) for the concepts: **what a
moving average is**, **/new vs /hot vs /rising**, **why the score is stored and
time-dependent**, **why `now` is explicit**, **5-minute buckets**, the
**activity weights**, **unique-actor anti-spam**, **why reports penalize**, and
**how keyset pagination works**. They are identical here. This README focuses on
the **one big difference** and the Sisal API pressure points it surfaces.

## The one big difference: no stored procedures

PostgreSQL lets you push the whole activity recorder and the scoring math into
the database as `CREATE FUNCTION` bodies, called as **one atomic statement**.
**SQLite (and therefore libSQL/Turso) has no SQL-language stored procedures.**
So in this example all of that logic lives in **TypeScript** and is orchestrated
through the Sisal query builder:

| Concern            | Neon / Postgres                                    | libSQL / Turso (here)                                |
| ------------------ | -------------------------------------------------- | ---------------------------------------------------- |
| 5-minute bucket    | `app.bucket_5m()` SQL function                     | `bucket5mIso()` in `src/rising.ts`                   |
| Record one event   | `app.record_post_activity()` — **one** call        | `recordPostActivity()` — a `db.transaction(...)`     |
| Per-bucket weights | `app.bucket_activity_score()` SQL function         | `bucketActivityScore()` in `src/rising.ts`           |
| Rising score       | `app.calculate_rising_score()` (`FILTER` sums)     | `calculateRisingScore()` over rows read into TS      |
| Recompute all      | `update … set rising_score = app.calc(…)` (1 stmt) | bulk read → compute in TS → `db.batch([...updates])` |
| Migrations         | 4 files (1 schema + 3 function files)              | **1 file** (schema only)                             |

The TypeScript model is not a "mirror" here — **it is the implementation**. This
is the single most important thing the pairing demonstrates: the same product
feature is a few database functions on Postgres and a transaction-orchestrated
TypeScript module on SQLite, and Sisal's builder carries the SQLite version
cleanly (transactions, upserts with raw-`sql` increments, and `db.batch`).

### The recorder, builder-native inside a transaction

`recordPostActivity` (`src/activity.ts`) runs three statements atomically.
`db.transaction(...)` hands the callback a **full builder-capable database**, so
no raw SQL strings are needed for the orchestration:

```ts
await db.transaction(async (tx) => {
  // 1. ON CONFLICT DO NOTHING + RETURNING → a row means a NEW actor in this bucket
  const inserted = await tx.insert(postActivityActors)
    .values({ post_id, bucket_start, actor_id, created_at })
    .onConflictDoNothing().returning().execute();
  const actorDelta = inserted.rows.length > 0 ? 1 : 0;

  // 2. upsert the bucket; increments + activity_score recompute use raw `sql`
  await tx.insert(postActivityBuckets)
    .values({/* fresh counters + computed activity_score */})
    .onConflictDoUpdate({
      target: [b.post_id, b.bucket_start],
      set: { upvotes: sql`${b.upvotes} + ${up}` /* … */ },
    }).execute();

  // 3. read the bucket back
  return (await tx.select().from(postActivityBuckets).where(/* … */).execute())[
    0
  ];
});
```

This **does** use an interactive transaction — the very thing the Neon sibling
avoids — because there is no function to push it into. On a local SQLite file or
Turso that is fine; the trade-off is the lesson.

## How to run

Prerequisites: [Deno](https://deno.com/) 2.x. No database setup needed — it
defaults to a **local SQLite file** (`file:./sisal-rising-feed.db`). For Turso,
set `TURSO_DATABASE_URL` (+ `TURSO_AUTH_TOKEN`), e.g. in a copied `.env`.

```sh
cd examples/libsql-rising-feed
deno task migrate             # apply the single schema migration
deno task seed                # insert 24 deterministic posts + activity
deno task demo                # print /new and /rising, boost a post, repaginate
deno task demo -- --reset     # start clean
```

> The native libSQL client needs `--allow-sys` (CPU/arch detection) and
> `--allow-ffi`; the bundled tasks already include them. Remote Turso only needs
> `--allow-net` + `--allow-env`.

### Reset / reseed / recompute

```sh
deno task reset               # DROP tables, then re-migrate
deno task seed                # reinsert deterministic demo data
deno task recompute           # recompute stored rising scores (at real now())
```

Because `rising_score` is time-dependent, `deno task recompute` uses the
**real** clock — right after a `seed` (pinned to `DEMO_NOW`) it will zero out
scores, which is expected. The demo always recomputes at `DEMO_NOW` for stable
output.

## What's Sisal-native and what's raw SQL

**Sisal-native (the fluent API was enough):**

- Typed table models with **DESC keyset indexes** (`src/schema.ts`).
- The **atomic recorder** — `db.transaction(...)` with an
  `insert().onConflictDoNothing().returning()` (new-actor detection), an
  `onConflictDoUpdate` upsert whose `set` uses raw-`sql` increments, and a
  `select()` readback (`src/activity.ts`).
- The **bulk recompute** — one read of recent buckets, compute in TS, then
  `db.batch([...updates])` as one atomic, non-interactive transaction
  (`src/recompute.ts`).
- **Both feeds** — `/new` and `/rising` via `.keyset({ orderBy, after })`
  (`src/queries.ts`).
- `db.$count` and builder inserts in the seed.

**Raw SQL (parameterized, isolated):**

- **The schema migration** — `CREATE TABLE` / `CREATE INDEX` with DESC ordering
  (`migrations/0001_init.sql`); the snapshot DDL generator emits only additive
  table/column DDL.
- **The raw `sql` increments** inside the bucket upsert's `set` — counter bumps
  and the `activity_score` recompute reference the existing row
  (`(upvotes + ?) * 1.0 + …`). Sisal has no arithmetic-assignment helper, so the
  expression is a `sql` fragment (parameterized).

Everything else — including the moving-window math and the bucket flooring — is
plain TypeScript, because there is no SQL function to host it.

## Sisal API pressure points

In addition to the ones in the
[Neon README](../neon-rising-feed/README.md#sisal-api-pressure-points):

1. **No portable "stored procedure" / transaction-script abstraction.** The
   recorder reads completely differently across engines (one `db.call` on
   Postgres, a `db.transaction` block here). A Sisal-level "atomic operation"
   that compiles to a function call where supported and an interactive
   transaction otherwise would let application code stay identical. (Relates to
   v0.5.0 roadmap items 4/5 and 7.)
2. **`db.call` / `defineFunction` have no SQLite equivalent** — correctly, since
   SQLite has no functions. This is a genuine dialect divergence; the pressure
   is that there is no _portable replacement_, so the gap shows up as duplicated
   logic between the two examples.
3. **No `FILTER` aggregates / interval math** (same as Neon) — here it pushed
   the moving-window sums entirely into TypeScript rather than a
   `sum(case when …)` query. Either is fine; a `filter`-aware aggregate would
   let it be one SQL read instead.
4. **`--allow-sys` is required** for the native libSQL client (CPU/arch probe
   via `@neon-rs/load`). Not a Sisal issue, but worth flagging for anyone wiring
   up permissions for `@sisal/libsql` on a local file.

## Production notes

This example keeps the recompute path deliberately simple. At scale you'd:

- **Recompute only dirty posts**, not every published post.
  `recomputeAllRisingScores` rescans all posts; production should recompute only
  posts with activity since their last `rising_score_updated_at` (e.g. a `dirty`
  set written by `recordPostActivity`).
- **Chunk large batches.** `recomputeAllRisingScores` puts one UPDATE per post
  into a single `db.batch([...])`. For thousands of posts, split the updates
  into chunks (e.g. 500 per batch) so no single transaction/round trip is huge.
- **Retain/consolidate old buckets.** Buckets older than the 120-minute window
  can never affect a rising score again — delete or roll them up periodically so
  `post_activity_buckets` doesn't grow without bound.
  (`recomputePostRisingScore` and `recomputeAllRisingScores` already only _read_
  buckets inside the window.)

## Tests

```sh
# network-free unit tests (the rising-score model + feed SQL)
deno task test

# database-backed integration test (temp file by default, or Turso)
SISAL_LIBSQL_RISING_FEED_IT=1 \
  deno test --allow-env --allow-net --allow-read --allow-write --allow-ffi --allow-sys \
  feed_db_test.ts
```

`feed_db_test.ts` covers the same ten behaviors as the Neon suite: bucket
creation, unique-actor dedup, weight ordering, recompute matching the model,
`/rising` ordering, keyset pagination without duplicates, moving-window decay,
and deterministic scoring — against a real SQLite database.

## Files

```
examples/libsql-rising-feed/
  README.md
  deno.json                 tasks (incl. --allow-sys for the native client)
  .env.example              optional TURSO_* / SISAL_LIBSQL_URL
  mod.ts                    entrypoint; re-exports + runs the demo
  rising_test.ts            network-free unit tests
  feed_db_test.ts           gated database integration test
  migrations/
    0001_init.sql           the ONLY migration: tables + DESC keyset indexes
  src/
    db.ts                   single connection (local file or Turso)
    schema.ts               typed defineTable models (TEXT ids/timestamps)
    rising.ts               the scoring model — the implementation, not a mirror
    activity.ts             recordPostActivity → db.transaction(...) orchestration
    queries.ts              getNewFeed + getRisingFeed (both .keyset())
    recompute.ts            recompute via bulk read + db.batch([...updates])
    seed.ts                 deterministic posts + activity at DEMO_NOW
    migrate.ts              applies the .sql file via @sisal/migrate splitter
    main.ts                 the demo
```
