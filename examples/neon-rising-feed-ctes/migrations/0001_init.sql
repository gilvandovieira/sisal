-- 0001_init.sql
-- Tables, constraints, and indexes for the Reddit-style "rising" feed — the
-- CTE-only variant.
--
-- THE BIG DIFFERENCE vs. examples/neon-rising-feed: there are NO database
-- functions here. No CREATE FUNCTION, no CREATE PROCEDURE, no PL/pgSQL, no
-- triggers. Every multi-step mutation (record activity, recompute scores) is
-- expressed as ONE data-modifying CTE statement from TypeScript instead. See
-- src/activity.ts and src/rising.ts, and the README "Why CTEs instead of
-- database functions?".
--
-- Hand-written SQL on purpose. Sisal's snapshot DDL generator
-- (`generatePostgresUpStatements`) emits only additive `CREATE TABLE` /
-- `ADD COLUMN`; the DESC keyset indexes below are out of its scope. The typed
-- `defineTable` mirror in `src/schema.ts` exists for the query builder; this
-- `.sql` file is the source of truth for the database shape.

create table if not exists posts (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text,
  status text not null default 'published',
  score integer not null default 0,
  -- Stored, indexable ranking value. Unlike a hot score it is TIME-DEPENDENT:
  -- it reflects recent activity relative to a moment, so it is recomputed (with
  -- an explicit p_now) rather than being stable for the post's lifetime.
  rising_score double precision not null default 0,
  -- When rising_score was last recomputed. Null until the first recompute.
  rising_score_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per (post, 5-minute time bucket). The moving-window score sums these
-- counters over recent buckets, so activity is pre-aggregated per bucket
-- instead of being scanned event-by-event on every read.
create table if not exists post_activity_buckets (
  post_id uuid not null references posts (id) on delete cascade,
  bucket_start timestamptz not null,
  upvotes integer not null default 0,
  downvotes integer not null default 0,
  comments integer not null default 0,
  reports integer not null default 0,
  -- Distinct actors that touched this post in this bucket (spam dampener).
  unique_actors integer not null default 0,
  -- Weighted score for this bucket, derived from the counters above. Computed
  -- inline inside the recording CTE (no app.bucket_activity_score function).
  activity_score double precision not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (post_id, bucket_start)
);

-- One row per (post, bucket, actor). Lets the recording CTE count an actor's
-- FIRST touch in a bucket exactly once, so unique_actors cannot be inflated by
-- the same actor acting repeatedly.
create table if not exists post_activity_actors (
  post_id uuid not null references posts (id) on delete cascade,
  bucket_start timestamptz not null,
  actor_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (post_id, bucket_start, actor_id)
);

-- Keyset (cursor) pagination indexes. Column order + DESC direction match the
-- ORDER BY in src/queries.ts so the feeds are index-ordered scans.
create index if not exists posts_rising_feed_idx
  on posts (status, rising_score desc, rising_score_updated_at desc, id desc);

create index if not exists posts_new_feed_idx
  on posts (status, created_at desc, id desc);

-- Window queries look up a post's recent buckets newest-first.
create index if not exists post_activity_buckets_post_bucket_idx
  on post_activity_buckets (post_id, bucket_start desc);

-- Cross-post bucket scans (e.g. "what is heating up right now").
create index if not exists post_activity_buckets_bucket_idx
  on post_activity_buckets (bucket_start desc);

-- The recording CTE looks up an actor's prior presence in a (post, bucket).
create index if not exists post_activity_actors_post_bucket_idx
  on post_activity_actors (post_id, bucket_start);
