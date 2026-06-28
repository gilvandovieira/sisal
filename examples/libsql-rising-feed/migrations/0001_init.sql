-- 0001_init.sql
-- Tables, constraints, and indexes for the Reddit-style "rising" feed on
-- libSQL / Turso (SQLite).
--
-- THE BIG DIFFERENCE vs. the Neon/Postgres sibling: this is the ONLY migration.
-- SQLite has no SQL-language stored procedures, so there is no app.bucket_5m,
-- no app.record_post_activity, and no app.calculate_rising_score here. All of
-- that logic lives in TypeScript (src/rising.ts, src/activity.ts,
-- src/recompute.ts) and is orchestrated through the Sisal query builder inside
-- a transaction. See the README "Sisal API pressure points" for why.
--
-- SQLite type notes:
--   * ids are TEXT (no uuid type) holding UUID strings;
--   * timestamps are TEXT holding ISO-8601 UTC strings ("...Z"), which sort
--     lexicographically in chronological order — that is what makes the keyset
--     feeds and the moving-window comparisons work with plain string compares;
--   * scores are REAL; counters are INTEGER.

create table if not exists posts (
  id text primary key,
  title text not null,
  body text,
  status text not null default 'published',
  score integer not null default 0,
  -- Stored, indexable, TIME-DEPENDENT ranking value (recomputed at an explicit
  -- `now`). See src/rising.ts.
  rising_score real not null default 0,
  rising_score_updated_at text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One row per (post, 5-minute bucket). bucket_start is the ISO string of the
-- floored time. The moving-window score sums activity_score over recent
-- buckets.
create table if not exists post_activity_buckets (
  post_id text not null references posts (id) on delete cascade,
  bucket_start text not null,
  upvotes integer not null default 0,
  downvotes integer not null default 0,
  comments integer not null default 0,
  reports integer not null default 0,
  unique_actors integer not null default 0,
  activity_score real not null default 0,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (post_id, bucket_start)
);

-- One row per (post, bucket, actor): lets the recorder count an actor's FIRST
-- touch in a bucket exactly once, so unique_actors can't be inflated by repeat
-- activity from the same actor.
create table if not exists post_activity_actors (
  post_id text not null references posts (id) on delete cascade,
  bucket_start text not null,
  actor_id text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (post_id, bucket_start, actor_id)
);

-- Keyset (cursor) pagination indexes. Column order + DESC direction match the
-- ORDER BY in src/queries.ts so the feeds are index-ordered scans.
create index if not exists posts_rising_feed_idx
  on posts (status, rising_score desc, rising_score_updated_at desc, id desc);

create index if not exists posts_new_feed_idx
  on posts (status, created_at desc, id desc);

create index if not exists post_activity_buckets_post_bucket_idx
  on post_activity_buckets (post_id, bucket_start desc);

create index if not exists post_activity_buckets_bucket_idx
  on post_activity_buckets (bucket_start desc);
