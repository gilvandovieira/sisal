# Neon activity vectors (Sisal example)

Prove Sisal can drive an **advanced SQL analytics pipeline** on Neon/Postgres:
take raw activity **events** and compute, set-based, a deterministic ordered
**activity vector** per post — then find _"posts that behaved like this post."_

This is **SQL feature vectorization**, not AI. The "vector" is an ordered
numeric projection of known product statistics — **not** a pgvector column,
**not** an embedding, **not** semantic search. The whole point is that **SQL is
a computation engine** here (time buckets, window-function moving averages,
rollups, batch computation over sets), not just CRUD.

Same line of thought as the `neon-*-feed` examples: shared `post_activity_*`
shapes, the explicit `p_now` discipline, the same hot/rising scores.

It is **not** an app — no auth, no HTTP, no frontend, no job queue, no external
services, **no AI model calls**. Just events, consolidation, vectors,
similarity, and retention.

> **Dialect note.** This example is Postgres-family (`@sisal/pg` /
> `@sisal/neon`) and uses advanced Postgres SQL on purpose (stored functions,
> `FILTER`, window functions, `array[...]`, `unnest WITH ORDINALITY`). A
> **planned** sibling `libsql-activity-vectors` (not built yet) would cover the
> SQLite family, where some of these have no equivalent (no stored functions, no
> array type) — which is exactly why the dialects get separate examples. Until
> it exists, the SQLite-family divergences are written up as future contracts in
> [`examples/advanced-sql-contracts`](../advanced-sql-contracts/README.md) (see
> [02-window-analytics](../advanced-sql-contracts/02-window-analytics.md) and
> [10-json-table-extraction](../advanced-sql-contracts/10-json-table-extraction.md)).

## The computation chain

```
raw post_events
   │  foldEventsToBuckets(from, until)     BUILDER: insert().select() + FILTER
   ▼                                       + dateTrunc + onConflictDoUpdate
post_activity_buckets (hourly)
   │  app.compute_post_activity_stats(p_now)        WINDOW moving averages, batch
   ▼
post_activity_stats (one row/post, named columns)
   │  app.post_activity_vector(post_id)             ARRAY[...] projection
   ▼
activity vector  ──►  cosine similarity ("similar posts")

post_activity_buckets ─ rollupDaily (builder) ─► post_activity_daily
post_activity_daily   ─ rollupMonthly (builder) ─► post_activity_monthly
post_events           ─ pruneEvents(before) (builder) ─► (deleted after consolidation)
```

Every arrow is **one set-based SQL statement over many rows** — batch
computation, not a row-by-row application loop. That is the thesis. Since v0.6
the fold, both rollups, and the prune are **typed builder statements**
(`src/events.ts`, `src/retention.ts` — the A1 rollup verification in
`docs/v0.6.0-roadmap.md`); only the window-function stats and the array/unnest
similarity remain SQL functions.

## What this example proves

- Sisal can express **time buckets, moving averages, recent-activity windows,
  rolling statistics, hourly→daily→monthly rollups, deterministic scoring, and
  feature-vector projections** against normal PostgreSQL.
- A useful **behavior similarity** comes from plain statistics — **no AI
  embeddings, no pgvector**.
- The vector is **deterministic and inspectable**: each dimension is a named,
  queryable column you can read in plain SQL.
- It documents honestly **what is Sisal-native and where raw SQL was required**
  (the pressure points) — it is built to push advanced SQL to the ORM's limits.

## What "vectorize activity" means (in small words)

A post does things over time: votes, comments, reports. "Vectorizing" means:
**measure a fixed set of those things and write them down as a list of numbers,
always in the same order.** That list is the post's vector. Two posts with
similar lists behaved similarly.

## Feature vectors vs AI embeddings

**Feature vectors** (this example): built from **known product statistics** with
a formula you wrote. Deterministic, easy to inspect, easy to debug. Good for
**behavior** similarity ("both are fast spikes"). Built with **SQL**.

**AI embeddings**: built by a **model** from text/images/events. Not
human-inspectable; capture **semantic** meaning ("both are about cooking"). A
separate, future concern — and the natural home for pgvector and `<=>`
operators. Not used here.

The important distinction:

- **pgvector** = AI / embedding similarity search.
- **activity vectors** = deterministic application analytics features.
- **SQL vectorization** = set-based batch computation with SQL windows,
  aggregates, and rollups.

## Why not pgvector / AI here

The question is _"do these posts **behave** alike?"_, not _"do they **mean** the
same thing?"_. Behavior is fully described by the activity numbers we already
have, so a model (and an extension, and a network call) would add cost and
opacity for no gain. Keeping it pure SQL + TypeScript also makes the vector math
unit-testable without a database. No `CREATE EXTENSION vector`, no
`vector(1536)`, no `<->`/`<#>`/`<=>`.

## The vector — what each dimension means

Version **`activity-v1`**, **9 dimensions, in this exact order** (see
`src/vector.ts` `VECTOR_DIMENSIONS` and `app.post_activity_vector`):

| # | Dimension          | Meaning                                            |
| - | ------------------ | -------------------------------------------------- |
| 0 | `votes_1h`         | votes in the current hour bucket                   |
| 1 | `comments_1h`      | comments in the current hour bucket                |
| 2 | `reports_1h`       | reports in the current hour bucket                 |
| 3 | `unique_actors_1h` | distinct actors in the current hour                |
| 4 | `vote_ma_6h`       | 6-bucket moving average of votes (window function) |
| 5 | `comment_ma_6h`    | 6-bucket moving average of comments                |
| 6 | `hot_score`        | stored `posts.hot_score`                           |
| 7 | `rising_score`     | stored `posts.rising_score`                        |
| 8 | `age_minutes`      | minutes since `created_at`                         |

The vector is a **projection of named columns** — we store each feature as its
own typed, queryable column in `post_activity_stats` (good for indexing and
plain-SQL inspection); the `double precision[]` array is just the
export/scoring/debug view of those columns.

### Why a version field

If the dimension order ever changes, old and new vectors are no longer
comparable (cosine over mismatched dimensions is meaningless). `VECTOR_VERSION`
marks the contract; bump it on any change so similarity only compares like with
like.

### Honest note on normalization

`activity-v1` keeps the dimensions **raw** (the deterministic projection your
spec asked for). Raw dimensions with a large range can dominate cosine —
`age_minutes` (hundreds–thousands) and the scores outweigh per-hour counts. In
practice the within-category vectors are near-identical so they still cluster
correctly (the demo: fast→fast 0.9997, report→report 1.0), but a future
`activity-v2` could standardize the columns before projecting. The version field
exists precisely so that change is safe.

## Similarity (the secondary payoff)

- **Cosine similarity** — _"do the two posts point the same way?"_ (angle,
  ignoring magnitude). 1 = same direction, 0 = unrelated / zero vector.
- **L2 distance** — _"how far apart are they?"_ (straight-line, magnitude
  included). 0 = identical.

`getSimilarPosts` scores in TypeScript over the projected vectors;
`getSimilarPostsSql` scores in Postgres via `app.cosine_similarity` over
`app.post_activity_vector(...)`.

## What this enables (later)

- **Recommendations** — build a _user_ vector from posts they engaged with;
  recommend posts with nearby vectors.
- **Moderation / anomaly detection** — flag suspicious shapes (high votes, very
  low `unique_actors` = vote manipulation; a reports spike).
- **Product analytics** — cluster posts into behavior types (fast spike, slow
  burner, comment-heavy, report-heavy, dead) for dashboards.
- **Feed ranking** — combine vector signals with the hot/rising/top feeds.

## Retention / consolidation

Raw events are kept short-term. Once folded into hourly buckets they roll up
into daily, then monthly, summaries — and the consolidated raw events are
pruned. Long-term statistics survive in the rollups even after the events are
gone. The demo runs `rollupDaily` → `rollupMonthly` → `pruneEvents` (all typed
builder statements since v0.6), then shows a post's vector is unchanged after
pruning. (Triggered manually here; in production an external cron/scheduler
calls them.)

> **Replay caution.** Pruning is one-way for the fold: re-running
> `foldEventsToBuckets` over a window whose events were already pruned would
> recompute from missing rows and _overwrite_ good bucket counters with zeros
> (replace-semantics idempotence cuts both ways). This example never re-folds
> behind the prune cutoff; the future ETL runner makes that mechanical — a
> per-job `pruned_before` replay horizon that refuses such windows with a typed
> error. See the replay-vs-retention invariant in
> [09-idempotent-backfill](../advanced-sql-contracts/09-idempotent-backfill.md).

## How to run

```sh
cp .env.example .env          # then fill in your Neon connection strings
deno task migrate             # tables + the SQL functions
deno task seed                # 24 deterministic posts + raw events (8 behaviors)
deno task generate            # fold events → buckets → compute stats
deno task demo                # the whole chain + similar posts + retention
deno task demo -- --reset     # drop + recreate the schema, then run the demo
deno task test                # network-free unit tests (no database)
```

`deno task demo` runs at a fixed `DEMO_NOW`, so the output is identical every
run. `--reset` recreates the schema; a plain `demo` clears the data and
re-seeds.

## A Sisal API this example wishes existed

The vector projection is hand-written `array[...]` SQL. A typed builder surface
would read like:

```ts
const activityVector = featureVector("activity_vector", [
  stats.votes1h.asFloat(),
  stats.comments1h.asFloat(),
  stats.reports1h.asFloat(),
  stats.uniqueActors1h.asFloat(),
  stats.voteMa6h,
  stats.commentMa6h,
  stats.hotScore,
  stats.risingScore,
  stats.ageMinutes,
]);
// →  ARRAY[ votes_1h::double precision, …, age_minutes ] AS activity_vector
```

That, plus a window-function builder, are the analytics primitives the roadmap
tracks (v0.6 ETL-readiness, v0.7 analytics). The insert-from-select rollup spine
this example needed is **builder-native since v0.6**.

## What's Sisal-native vs raw SQL

**Sisal-native:** typed `defineTable` models (`src/schema.ts`); the batch event
insert (`recordEvents`); **the events→buckets fold** (`foldEventsToBuckets` —
`insert().select()` + `FILTER` + `dateTrunc` + `onConflictDoUpdate`, one
statement); **the daily/monthly rollups and the event prune**
(`src/retention.ts`, same shape + a bulk `delete()`); reading stats and listing
posts (builder `select`); the similarity candidate loading; the migration runner
(`splitSqlStatements`).

**Raw SQL (the genuinely-unbuilt analytics core):** the three `app.*` functions
left in `migrations/0002_functions.sql` — window-function moving averages, the
`ARRAY[...]` vector projection, `unnest WITH ORDINALITY` cosine similarity —
called from `src/{stats,queries}.ts`.

## Sisal API pressure points

Honest gaps this example surfaced (candidates for `docs/v0.6.0-roadmap.md` /
`docs/v0.7.0-roadmap.md`). It is built to find the ORM's limits.

1. **`CREATE FUNCTION` has no builder.** The remaining computation engine is
   hand-written SQL functions.
2. **No window-function builder.** `vote_ma_6h` / `comment_ma_6h` use
   `avg(...) OVER (… ROWS BETWEEN 5 PRECEDING AND CURRENT ROW)`; there is no
   `over(...)` surface (v0.7 analytics-readiness — Sisal has no window functions
   at all today).
3. **No array/vector projection builder.** The `ARRAY[...] AS activity_vector`
   projection and `app.post_activity_vector` are raw (the `featureVector(...)`
   sketch above is the wished-for API).
4. **`double precision[]` similarity in SQL is raw.** `app.cosine_similarity`
   uses `unnest … WITH ORDINALITY`.
5. **No typed caller for a `RETURNS TABLE` / scalar SQL function.** The
   functions are invoked through the raw `sql` tag.
6. **Schema mirror is informational for the computed tables.** `src/schema.ts`
   types the builder-native paths; the SQL functions bypass it (the `.sql`
   migrations are the source of truth).

**Resolved in v0.6 (was pressure point #2):** insert-from-select. The fold and
both rollups (`INSERT … SELECT … GROUP BY … ON CONFLICT`) now compose through
the typed builder — converted here as the roadmap's A1 verification, pinned by
`packages/orm/etl_rollup_test.ts` and the per-adapter `ETL rollup` integration
tests. The upsert's proposed-row references use the typed `excluded()` helper
(C2 — dialect-mapped, MySQL-ready); the one residual raw seam inside those
statements is `coalesce(...)` (via the `sql` tag).

Notably **NOT** pressure points: the batch event insert and the stats/posts
reads are clean builder code; bigint ids round-trip as strings as documented.

## Testing

```sh
# network-free unit tests (the vector projection + similarity math)
deno task test

# database-backed integration test — RESETS the target DB; use a scratch branch
SISAL_NEON_ACTIVITY_VECTORS_IT=1 \
  DATABASE_URL="postgres://user:pw@ep-xxx.neon.tech/db?sslmode=require" \
  deno test -A feature_db_test.ts
```

The gated test verifies the whole chain: migrations + functions, deterministic
seed, the events→buckets fold, the window-function stats (exact values for known
data), the SQL↔TS vector projection match, similarity (source excluded,
same-category nearest), retention rollups + event pruning (stats survive), and
`DEMO_NOW` determinism.
